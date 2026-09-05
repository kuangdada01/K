/**
 * ============================================================
 * 邮件发送模块
 * ============================================================
 * 使用 nodemailer 通过 SMTP 发送邮件
 *
 * 配置: 在 .env 中设置 SMTP_HOST/PORT/USER/PASS
 *
 * 支持: QQ邮箱、163邮箱、Gmail 等任何 SMTP 服务
 * ============================================================
 */

import nodemailer from 'nodemailer';
import { env } from './config';

/** SMTP 邮件传输实例（惰性初始化） */
let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST || 'smtp.qq.com',
      port: env.SMTP_PORT || 465,
      secure: true, // SSL
      auth: {
        user: env.SMTP_USER || '',
        pass: env.SMTP_PASS || '',
      },
    });
  }
  return transporter;
}

/**
 * 发送邮箱验证码
 *
 * @param toEmail - 收件人邮箱地址
 * @param code - 6位数字验证码
 * @param purpose - 验证码用途: 'register'=注册 | 'reset'=重置密码
 * @returns 发送结果信息
 */
export async function sendVerificationCode(
  toEmail: string,
  code: string,
  purpose: 'register' | 'reset' = 'register'
) {
  const isRegister = purpose === 'register';
  const subject = isRegister ? 'K - 注册验证码' : 'K - 重置密码验证码';
  const hint = isRegister ? '欢迎注册，请使用以下验证码完成注册' : '你正在重置密码，请使用以下验证码完成验证';
  const mailOptions = {
    from: `"K" <${env.SMTP_USER ?? 'noreply@example.com'}>`,
    to: toEmail,
    subject,
    html: `
      <div style="max-width:480px;margin:0 auto;padding:32px 24px;font-family:Arial,sans-serif;background:#fff;border-radius:12px;border:1px solid #e8e8e8">
        <h1 style="text-align:center;color:#262626;font-size:28px;margin:0 0 8px">K</h1>
        <p style="text-align:center;color:#8e8e8e;font-size:14px;margin:0 0 32px">${hint}</p>
        <div style="background:#fafafa;border-radius:8px;padding:24px;text-align:center;margin-bottom:24px">
          <span style="font-size:36px;font-weight:bold;color:#262626;letter-spacing:8px">${code}</span>
        </div>
        <p style="color:#8e8e8e;font-size:13px;text-align:center;margin:0">验证码 10 分钟内有效，请勿泄露给他人</p>
      </div>
    `,
  };

  const info = await getTransporter().sendMail(mailOptions);
  return info;
}
