import { execa } from 'execa';

import fs from 'fs/promises'

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

const isGitRepo = async () => {
  try {
    const status = await execa('git', ['status'])
    return true
  } catch (error) {
    return false
  }
}

const checkGitIgnore = async path => {
  try {
    const { stdout } = await execa('git', ['check-ignore', path])
    return true
  } catch (error) {
    return false
  }
}

const addToGitIgnore = async path => {
  const isRepo = await isGitRepo();
  const isIgnored = await checkGitIgnore(path)
  if(isRepo && !isIgnored) {
    console.log(".credenv added to gitignore for you - don't want to accidentally commit these :)")
    await fs.appendFile('.gitignore', path)
  }
}

const validateCredentials = async credentials => {
  console.log("Validating and transforming credentials...")
  credentials.otp = credentials.fields.find(field => field.type === 'OTP')?.totp
  credentials.mfa_serial = credentials.fields.find(field => field.label === 'mfa_serial')?.value
  credentials.aws_key = credentials.fields.find(field => field.label === 'aws_access_key_id').value
  credentials.aws_secret = credentials.fields.find(field => field.label === 'aws_secret_access_key').value

  credentials.mfa_enabled = false
  if(credentials.otp !== undefined && credentials.mfa_serial !== undefined) {
    credentials.mfa_enabled = true
  }

  return credentials
}

export { getAWSAccounts, getAWSAccountDetails, getOPItem, addToGitIgnore, validateCredentials }