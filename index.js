import { Command } from 'commander';

import { execa } from 'execa';

import fs from 'fs/promises'
import inquirer from 'inquirer';
import path from 'path'

const program = new Command();

const getOPAccounts = async () => {
  const { stdout} = await execa('op', ['account', 'ls', '--format=json']);
  const accounts = JSON.parse(stdout);

  return accounts
}

const getOPItems = async () => {
  const accounts = await getOPAccounts();

  const items = await Promise.all(accounts.map(async account => {
    await execa('op', ['signin', '--account', account.user_uuid]);
    const { stdout } = await execa('op', ['item', 'list', '--long', '--format=json']);
    const items = JSON.parse(stdout);
    
    return items.map(item => ({ ...item, account_id: account.user_uuid }))
  }));

  return items.flat();
}

const getAWSAccounts = async () => {
  const items = await getOPItems();

  const awsAccounts = items.filter(item => item.tags?.includes('aws'));

  return awsAccounts
}

const getAWSAccountDetails = async env => {
  try {
    console.log(env)
    const { stdout } = await execa('aws', ['sts', 'get-caller-identity', '--output', 'json'], { env: env })
    return JSON.parse(stdout);
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
}

const getOPItem = async (item_id, account_id) => {
  const { stdout } = await execa('op', ['item', 'get', item_id, '--format=json', '--account', account_id]);
  return JSON.parse(stdout);
}

program
  .name('aws-op')
  .description('CLI tool for managing AWS authentication via 1Password')
  .version('0.0.1');

program.command('list')
  .description('List all AWS accounts')
  .action(async () => {
    const accounts = await getAWSAccounts();
    const answers = await inquirer.prompt([{
      type: 'list',
      name: 'account',
      message: 'Which account do you want to use?',
      choices: accounts.map(account => ({ name: account.title, value: account })),
    }]);

    console.log(answers.account)
  });

program.command('use')
  .description('Login to an AWS account')
  .option('-a, --account <account>', '1Password item ID')
  .action(async options => {
    const accounts = await getAWSAccounts();
    let account, stdout;
    const env = {}

    if(options.hasOwnProperty('account')) {
      account = accounts.find(account => account.id === options.account);

      if(account === undefined) {
        console.error(`Account ${options.account} not found`);
        process.exit(1);
      }
    } else {
      const answers = await inquirer.prompt([{
        type: 'list',
        name: 'account',
        message: 'Which account do you want to use?',
        choices: accounts.map(account => ({ name: account.title, value: account })),
      }]);
  
      account = answers.account;
    }

    const credentials = await getOPItem(account.id, account.account_id);

    credentials.hasRoles = credentials.hasOwnProperty('sections') && credentials.sections.some(section => section.label === 'Roles');

    if(credentials.hasRoles) {
      const roles = credentials.fields.filter(field => field.section?.label === 'Roles')

      const choices = [{ name: 'None', value: null }, ...roles.map(role => ({ name: role.label, value: role }))]

      const answers = await inquirer.prompt([{
        type: 'list',
        name: 'role',
        message: 'Which role do you want to use?',
        choices: choices,
      }]);

      credentials.selectedRole = answers.role;
    }

    env.AWS_OP_ID = account.id;
    env.AWS_ACCESS_KEY_ID = credentials.fields.find(field => field.label === 'aws_access_key_id').value
    env.AWS_SECRET_ACCESS_KEY = credentials.fields.find(field => field.label === 'aws_secret_access_key').value

    const awsId = await getAWSAccountDetails(env);

    env.AWS_ACCOUNT_ID = awsId.Account;
    env.AWS_MFA_DEVICE_ARN = credentials.fields.find(field => field.label === 'mfa_serial')?.value
    env.AWS_VAULT = `${account.title}`

    const OTP = credentials.fields.find(field => field.type === 'OTP')?.totp

    if(credentials.hasRoles && credentials.selectedRole !== null) {
      // Get role session
      const roleSessionName = `${awsId.Arn.split('/')[1]}-${credentials.selectedRole.label}`;
      const { stdout: assumeRoleStdout } = await execa('aws', ['sts', 'assume-role', '--role-arn', credentials.selectedRole.value, '--role-session-name', roleSessionName, '--serial-number', env.AWS_MFA_DEVICE_ARN, '--token-code', OTP], { env: env })
      const assumeRole = JSON.parse(assumeRoleStdout);

      env.AWS_ACCESS_KEY_ID = assumeRole.Credentials.AccessKeyId;
      env.AWS_SECRET_ACCESS_KEY = assumeRole.Credentials.SecretAccessKey;
      env.AWS_SESSION_TOKEN = assumeRole.Credentials.SessionToken;
    }

    if(OTP !== undefined) {
      // Get session token
      const { stdout: sessionTokenStdout } = await execa('aws', ['sts', 'get-session-token', '--serial-number', env.AWS_MFA_DEVICE_ARN, '--token-code', OTP], { env: env })
      const sessionToken = JSON.parse(sessionTokenStdout);

      env.AWS_ACCESS_KEY_ID = sessionToken.Credentials.AccessKeyId;
      env.AWS_SECRET_ACCESS_KEY = sessionToken.Credentials.SecretAccessKey;
      env.AWS_SESSION_TOKEN = sessionToken.Credentials.SessionToken;
    }

    // Write to .env file

    const envFile = Object.entries(env).map(([key, value]) => `export ${key}=${value}`).join('\n')

    await fs.writeFile(path.join(process.cwd(), '.credentials.json'), JSON.stringify(credentials), { encoding: 'utf8' })
    await fs.writeFile(path.join(process.cwd(), '.credenv'), envFile)

    console.log('Credentials written to .credenv')
    console.log('Run `source .credenv && rm .credenv` to use the credentials')
  });

program.parse();