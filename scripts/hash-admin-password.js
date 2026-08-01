'use strict';

const crypto = require('node:crypto');
const readline = require('node:readline');

const input = readline.createInterface({ input: process.stdin, output: process.stdout });
input.question('请输入网页管理员密码：', password => {
  input.close();
  if (password.length < 12) {
    console.error('密码至少需要12位。');
    process.exitCode = 1;
    return;
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  console.log(`${salt}:${hash}`);
});
