import nodemailer from 'nodemailer';
import type { MailMessage } from './mail.js';

export interface MailTransport {
  send(id: string, message: MailMessage): Promise<void>;
  close(): void;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  from: string;
  user: string;
  password: string;
  ca?: string;
}

export class SmtpMailTransport implements MailTransport {
  private readonly transport;

  constructor(private readonly config: SmtpConfig) {
    this.transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      requireTLS: !config.secure,
      auth: { user: config.user, pass: config.password },
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, ...(config.ca ? { ca: config.ca } : {}) },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }

  async send(id: string, message: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.config.from,
      to: message.recipient,
      subject: message.subject,
      text: message.text,
      messageId: `<${id}@${this.config.from.slice(this.config.from.lastIndexOf('@') + 1)}>`,
    });
  }

  close(): void {
    this.transport.close();
  }
}
