import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';

const transporter = env.SMTP_HOST
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 10000,
      auth: env.SMTP_USER && env.SMTP_PASSWORD ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    })
  : null;

export async function sendPasswordResetOtp(email: string, code: string): Promise<void> {
  if (!transporter || !env.SMTP_FROM) {
    throw new AppError(503, 'email_delivery_unavailable', 'Password reset email delivery is temporarily unavailable.');
  }

  try {
    await transporter.sendMail({
      from: env.SMTP_FROM,
      to: email,
      subject: 'Your password reset code',
      text: `Your Voice Of Digi Bengal password reset code is ${code}. It expires in ${env.PASSWORD_RESET_OTP_TTL_MINUTES} minutes. If you did not request this, you can ignore this email.`,
      html: `<p>Your Voice Of Digi Bengal password reset code is:</p><p style="font-size:24px;font-weight:700;letter-spacing:4px">${code}</p><p>This code expires in ${env.PASSWORD_RESET_OTP_TTL_MINUTES} minutes. If you did not request this, you can ignore this email.</p>`,
    });
  } catch {
    throw new AppError(503, 'email_delivery_unavailable', 'Password reset email delivery is temporarily unavailable.');
  }
}

export async function sendNewsletterConfirmation(email: string, token: string): Promise<void> {
  if (!transporter || !env.SMTP_FROM) {
    throw new AppError(503, 'email_delivery_unavailable', 'Newsletter email delivery is temporarily unavailable.');
  }

  const confirmationUrl = `${env.FRONTEND_URL}/newsletter/confirm?token=${encodeURIComponent(token)}`;
  const unsubscribeUrl = `${env.FRONTEND_URL}/newsletter/unsubscribe?token=${encodeURIComponent(token)}`;
  try {
    await transporter.sendMail({
      from: env.SMTP_FROM,
      to: email,
      subject: 'Confirm your Bengal Rising Briefings subscription',
      text: `Confirm your subscription: ${confirmationUrl}\n\nYou can unsubscribe at any time: ${unsubscribeUrl}`,
      html: `<p>Confirm your Bengal Rising Briefings subscription:</p><p><a href="${confirmationUrl}">Confirm subscription</a></p><p><a href="${unsubscribeUrl}">Unsubscribe</a></p>`,
    });
  } catch {
    throw new AppError(503, 'email_delivery_unavailable', 'Newsletter email delivery is temporarily unavailable.');
  }
}