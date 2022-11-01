# AWS 1Password Authentication helper

## Dependancies

* [1Password CLI](https://support.1password.com/command-line-getting-started/)
* [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/cli-chap-install.html)

## Installation

Should be as simple as `npm i -g aws-op` (once I get it published)

## Usage

`aws-op` will look in your 1password accounts for items with the tag `aws` and then prompt you to select one. It will then use the `aws_access_key_id` and `aws_secret_access_key` fields to set the appropriate environment variables for the AWS CLI. If you have a `region` field it will also set that along with using an MFA token if you have one. Make sure to set the `mfa_serial` field to the ARN of your MFA device.

Please open an issue if you have any problems or suggestions.