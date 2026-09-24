const nodemailer = require('nodemailer');
require('dotenv').config();

const APP_NAME = () => process.env.APP_NAME || 'MarkMate';
const APP_COLOR = () => process.env.APP_COLOR || '#4F46E5';
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class EmailService {
  constructor() {
    // Create transporter - supports multiple email providers
    this.transporter = null;
    this.initializeTransporter();
  }

  initializeTransporter() {
    // Gmail: use GMAIL_USER + GMAIL_APP_PASSWORD (App Password from Google Account)
    if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
      this.transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: process.env.GMAIL_USER,
          pass: process.env.GMAIL_APP_PASSWORD
        }
      });
      console.log('📧 Email: Gmail configured for', process.env.GMAIL_USER);
    } else if (process.env.SMTP_HOST && process.env.SMTP_PORT) {
      // Generic SMTP
      this.transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true' || false,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      });
    } else if (process.env.SMTP_SERVICE && process.env.SMTP_USER && process.env.SMTP_PASS) {
      // Other services (Outlook, etc.) or Gmail via SMTP_* vars
      this.transporter = nodemailer.createTransport({
        service: process.env.SMTP_SERVICE,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      });
    } else {
      // Development mode - use console logging instead
      console.warn('⚠️  Email service not configured. Emails will be logged to console.');
      console.warn('⚠️  To use Gmail, add to .env:');
      console.warn('   GMAIL_USER=yourname@gmail.com');
      console.warn('   GMAIL_APP_PASSWORD=your-16-char-app-password');
      console.warn('   (Create App Password at: https://myaccount.google.com/apppasswords)');
      this.transporter = {
        sendMail: async (options) => {
          console.log('\n=== 📧 EMAIL (not sent - SMTP not configured) ===');
          console.log('To:', options.to);
          console.log('Subject:', options.subject);
          console.log('---');
          // Extract verification URL from HTML or text
          const urlMatch = options.html?.match(/href="([^"]+)"/) || options.text?.match(/(https?:\/\/[^\s]+)/);
          if (urlMatch) {
            console.log('Verification URL:', urlMatch[1]);
          }
          console.log('==========================================\n');
          return { messageId: 'console-log' };
        }
      };
    }
  }

  async sendVerificationEmail(email, token, name) {
    // Set CLIENT_URL in .env to your app URL (e.g. https://markmate.io/tools) so verification links are correct
    const baseUrl = process.env.CLIENT_URL || process.env.BASE_URL || 'http://localhost:3000';
    const verificationUrl = `${baseUrl.replace(/\/$/, '')}/verify-email?token=${token}`;

    const mailOptions = {
      from: process.env.SMTP_FROM || process.env.GMAIL_USER || process.env.SMTP_USER || 'noreply@markmate.com',
      to: email,
      subject: 'Verify your MarkMate account',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Verify your account</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background-color: #4F46E5; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
            <h1 style="margin: 0;">MarkMate</h1>
          </div>
          <div style="background-color: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px;">
            <h2 style="color: #1f2937; margin-top: 0;">Verify your email address</h2>
            <p>Hello${name ? ` ${name}` : ''},</p>
            <p>Thank you for registering with MarkMate! Please verify your email address by clicking the button below:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${verificationUrl}" style="background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">Verify Email Address</a>
            </div>
            <p style="font-size: 14px; color: #6b7280;">Or copy and paste this link into your browser:</p>
            <p style="font-size: 12px; color: #9ca3af; word-break: break-all;">${verificationUrl}</p>
            <p style="font-size: 14px; color: #6b7280; margin-top: 30px;">This link will expire in 24 hours.</p>
            <p style="font-size: 14px; color: #6b7280;">If you didn't create an account, you can safely ignore this email.</p>
          </div>
          <div style="text-align: center; margin-top: 20px; color: #9ca3af; font-size: 12px;">
            <p>© ${new Date().getFullYear()} MarkMate. All rights reserved.</p>
          </div>
        </body>
        </html>
      `,
      text: `
        Verify your MarkMate account
        
        Hello${name ? ` ${name}` : ''},
        
        Thank you for registering with MarkMate! Please verify your email address by visiting the following link:
        
        ${verificationUrl}
        
        This link will expire in 24 hours.
        
        If you didn't create an account, you can safely ignore this email.
      `
    };

    try {
      const info = await this.transporter.sendMail(mailOptions);
      console.log('Verification email sent:', info.messageId);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error('Error sending verification email:', error);
      throw error;
    }
  }

  // Sent when a lecturer enrols a student. A new or not-yet-activated account gets a
  // link to set their name and password; an active one just gets a login link.
  async sendEnrolmentEmail({ email, name, courseName, courseCode, invitedBy, setupUrl, loginUrl }) {
    const app = APP_NAME();
    const color = APP_COLOR();
    const hasSetup = Boolean(setupUrl);
    const actionUrl = hasSetup ? setupUrl : loginUrl;
    const actionLabel = hasSetup ? 'Set up my account' : `Open ${app}`;
    const course = `${courseName}${courseCode ? ` (${courseCode})` : ''}`;
    const mailOptions = {
      from: process.env.SMTP_FROM || process.env.GMAIL_USER || process.env.SMTP_USER || 'noreply@markmate.com',
      to: email,
      subject: `You have been enrolled in ${courseName}`,
      html: `
        <!DOCTYPE html>
        <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background-color: ${color}; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
            <h1 style="margin: 0;">${esc(app)}</h1>
          </div>
          <div style="background-color: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px;">
            <h2 style="color: #1f2937; margin-top: 0;">You are enrolled in ${esc(course)}</h2>
            <p>Hello${name ? ` ${esc(name)}` : ''},</p>
            <p>${invitedBy ? `${esc(invitedBy)} has enrolled you` : 'You have been enrolled'} in <strong>${esc(course)}</strong> on ${esc(app)}.</p>
            ${hasSetup
              ? '<p>Before you start, please set your name and choose a password. It only takes a moment.</p>'
              : '<p>Your modules and quizzes are ready for you. Log in to get started.</p>'}
            <div style="text-align: center; margin: 30px 0;">
              <a href="${actionUrl}" style="background-color: ${color}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">${esc(actionLabel)}</a>
            </div>
            <p style="font-size: 14px; color: #6b7280;">Or copy and paste this link into your browser:</p>
            <p style="font-size: 12px; color: #9ca3af; word-break: break-all;">${actionUrl}</p>
            ${hasSetup ? '<p style="font-size: 14px; color: #6b7280;">This link is personal to you and expires in 7 days.</p>' : ''}
          </div>
          <div style="text-align: center; margin-top: 20px; color: #9ca3af; font-size: 12px;">
            <p>&copy; ${new Date().getFullYear()} ${esc(app)}. All rights reserved.</p>
          </div>
        </body></html>
      `,
      text: `You are enrolled in ${course}\n\nHello${name ? ` ${name}` : ''},\n\n${invitedBy ? `${invitedBy} has enrolled you` : 'You have been enrolled'} in ${course} on ${app}.\n\n${hasSetup ? 'Set your name and password here' : 'Log in here'}: ${actionUrl}\n`,
    };
    try {
      const info = await this.transporter.sendMail(mailOptions);
      console.log('Enrolment email sent:', info.messageId);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error('Error sending enrolment email:', error);
      throw error;
    }
  }

  async sendHomeworkEmail({ email, name, moduleName, assignedBy, loginUrl }) {
    const app = APP_NAME();
    const color = APP_COLOR();
    const mailOptions = {
      from: process.env.SMTP_FROM || process.env.GMAIL_USER || process.env.SMTP_USER || 'noreply@markmate.com',
      to: email,
      subject: `New homework for you: ${moduleName}`,
      html: `
        <!DOCTYPE html>
        <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background-color: ${color}; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
            <h1 style="margin: 0;">${esc(app)}</h1>
          </div>
          <div style="background-color: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px;">
            <h2 style="color: #1f2937; margin-top: 0;">You have new homework</h2>
            <p>Hello${name ? ` ${esc(name)}` : ''},</p>
            <p>${assignedBy ? `${esc(assignedBy)} has prepared` : 'Your lecturer has prepared'} a personalised homework module for you, based on your recent work:</p>
            <p style="font-size: 16px;"><strong>${esc(moduleName)}</strong></p>
            <p>It contains a short lesson and an activity to help you strengthen the areas you found tricky.</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${loginUrl}" style="background-color: ${color}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">Open my homework</a>
            </div>
            <p style="font-size: 12px; color: #9ca3af; word-break: break-all;">${loginUrl}</p>
          </div>
        </body></html>
      `,
      text: `You have new homework\n\nHello${name ? ` ${name}` : ''},\n\n${assignedBy ? `${assignedBy} has prepared` : 'Your lecturer has prepared'} a personalised homework module for you: ${moduleName}\n\nOpen it here: ${loginUrl}\n`,
    };
    try {
      const info = await this.transporter.sendMail(mailOptions);
      console.log('Homework email sent:', info.messageId);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error('Error sending homework email:', error);
      throw error;
    }
  }

  async sendPasswordResetEmail(email, token, name) {
    const resetUrl = `${require('./accountSetupService').getAppUrl()}/reset-password?token=${token}`;

    const mailOptions = {
      from: process.env.SMTP_FROM || process.env.GMAIL_USER || process.env.SMTP_USER || 'noreply@markmate.com',
      to: email,
      subject: `Reset your ${APP_NAME()} password`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Reset your password</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background-color: ${APP_COLOR()}; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
            <h1 style="margin: 0;">${esc(APP_NAME())}</h1>
          </div>
          <div style="background-color: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px;">
            <h2 style="color: #1f2937; margin-top: 0;">Reset your password</h2>
            <p>Hello${name ? ` ${name}` : ''},</p>
            <p>We received a request to reset your password. Click the button below to reset it:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${resetUrl}" style="background-color: ${APP_COLOR()}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">Reset Password</a>
            </div>
            <p style="font-size: 14px; color: #6b7280;">Or copy and paste this link into your browser:</p>
            <p style="font-size: 12px; color: #9ca3af; word-break: break-all;">${resetUrl}</p>
            <p style="font-size: 14px; color: #6b7280; margin-top: 30px;">This link will expire in 1 hour.</p>
            <p style="font-size: 14px; color: #6b7280;">If you didn't request a password reset, you can safely ignore this email.</p>
          </div>
          <div style="text-align: center; margin-top: 20px; color: #9ca3af; font-size: 12px;">
            <p>© ${new Date().getFullYear()} ${esc(APP_NAME())}. All rights reserved.</p>
          </div>
        </body>
        </html>
      `,
      text: `
        Reset your ${APP_NAME()} password
        
        Hello${name ? ` ${name}` : ''},
        
        We received a request to reset your password. Visit the following link to reset it:
        
        ${resetUrl}
        
        This link will expire in 1 hour.
        
        If you didn't request a password reset, you can safely ignore this email.
      `
    };

    try {
      const info = await this.transporter.sendMail(mailOptions);
      console.log('Password reset email sent:', info.messageId);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error('Error sending password reset email:', error);
      throw error;
    }
  }
}

module.exports = new EmailService();
