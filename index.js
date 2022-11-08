import { Command } from 'commander';

import { execa } from 'execa';

import fs from 'fs/promises'
import inquirer from 'inquirer';
import path from 'path'

import { addToGitIgnore, getOPItem, getAWSAccounts, getAWSAccountDetails, validateCredentials } from './lib.js'

const program = new Command();

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

    const loadedCredentials = await getOPItem(account.id, account.account_id);
    const credentials = await validateCredentials(loadedCredentials);

    credentials.hasRoles = credentials.hasOwnProperty('sections') && credentials.sections.some(section => section.label === 'Roles');
    credentials.selectedRole = null

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
    env.AWS_ACCESS_KEY_ID = credentials.aws_key
    env.AWS_SECRET_ACCESS_KEY = credentials.aws_secret

    const awsId = await getAWSAccountDetails(env);

    env.AWS_ACCOUNT_ID = awsId.Account;
    env.AWS_MFA_DEVICE_ARN = credentials.mfa_serial
    env.AWS_VAULT = `${account.title}`

    if(credentials.hasRoles && credentials.selectedRole !== null) {
      // Get role session
      const roleSessionName = `${awsId.Arn.split('/')[1]}-${credentials.selectedRole.label}`;
      const { stdout: assumeRoleStdout } = await execa('aws', ['sts', 'assume-role', '--role-arn', credentials.selectedRole.value, '--role-session-name', roleSessionName, '--serial-number', credentials.mfa_serial, '--token-code', credentials.otp], { env: env })
      const assumeRole = JSON.parse(assumeRoleStdout);

      env.AWS_ACCESS_KEY_ID = assumeRole.Credentials.AccessKeyId;
      env.AWS_SECRET_ACCESS_KEY = assumeRole.Credentials.SecretAccessKey;
      env.AWS_SESSION_TOKEN = assumeRole.Credentials.SessionToken;
    }

    if(credentials.mfa_enabled) {
      // Get session token
      try {
        const { stdout: sessionTokenStdout } = await execa('aws', ['sts', 'get-session-token', '--serial-number', credentials.mfa_serial, '--token-code', credentials.otp], { env: env })
        const sessionToken = JSON.parse(sessionTokenStdout);
  
        env.AWS_ACCESS_KEY_ID = sessionToken.Credentials.AccessKeyId;
        env.AWS_SECRET_ACCESS_KEY = sessionToken.Credentials.SecretAccessKey;
        env.AWS_SESSION_TOKEN = sessionToken.Credentials.SessionToken;
      } catch (error) {
        console.log(error.stderr)
        process.exit(1);
      }
    }

    // Write to .env file

    const envFile = Object.entries(env).map(([key, value]) => `export ${key}=${value}`).join('\n')

    await fs.writeFile(path.join(process.cwd(), '.credenv'), envFile)
    await addToGitIgnore('.credenv')

    console.log('Credentials written to .credenv')
    console.log('Run `source .credenv && rm .credenv` to use the credentials')
  });

program.parse();