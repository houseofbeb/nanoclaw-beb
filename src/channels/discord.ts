import {
  Client,
  GatewayIntentBits,
  TextChannel,
  Message,
  Partials,
} from 'discord.js';

import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata } from '../types.js';

const DISCORD_MSG_LIMIT = 2000;

export interface DiscordChannelOpts {
  token: string;
  channelId: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client;
  private connected = false;
  private opts: DiscordChannelOpts;

  constructor(opts: DiscordChannelOpts) {
    this.opts = opts;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Message, Partials.Channel],
    });
  }

  jid(): string {
    return `discord-${this.opts.channelId}`;
  }

  ownsJid(jid: string): boolean {
    return jid === this.jid();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.client.once('ready', () => {
        this.connected = true;
        logger.info({ channelId: this.opts.channelId }, 'Discord connected');

        // Announce the channel in the DB
        this.opts.onChatMetadata(
          this.jid(),
          new Date().toISOString(),
          'Discord',
          'discord',
          true,
        );

        resolve();
      });

      this.client.on('error', (err) => {
        logger.error({ err }, 'Discord client error');
      });

      this.client.on('messageCreate', (msg: Message) => {
        // Only handle messages from the configured channel
        if (msg.channelId !== this.opts.channelId) return;
        // Ignore bot messages (including our own)
        if (msg.author.bot) return;

        const jid = this.jid();
        const now = new Date().toISOString();

        this.opts.onChatMetadata(jid, now, 'Discord', 'discord', true);

        // Collect image URLs from attachments and embeds
        const imageUrls: string[] = [];
        for (const [, attachment] of msg.attachments) {
          if (attachment.contentType?.startsWith('image/')) {
            imageUrls.push(attachment.url);
          }
        }
        for (const embed of msg.embeds) {
          if (embed.image?.url) imageUrls.push(embed.image.url);
          else if (embed.thumbnail?.url) imageUrls.push(embed.thumbnail.url);
        }
        const content = imageUrls.length > 0
          ? `${msg.content}\n${imageUrls.join('\n')}`.trim()
          : msg.content;

        this.opts.onMessage(jid, {
          id: msg.id,
          chat_jid: jid,
          sender: msg.author.id,
          sender_name: msg.member?.displayName || msg.author.username,
          content,
          timestamp: now,
          is_from_me: false,
          is_bot_message: false,
        });
      });

      this.client.login(this.opts.token).catch(reject);
    });
  }

  async sendMessage(_jid: string, text: string): Promise<void> {
    const channel = await this.client.channels.fetch(this.opts.channelId);
    if (!channel || !(channel instanceof TextChannel)) {
      throw new Error(`Discord channel ${this.opts.channelId} not found or not a text channel`);
    }

    // Split into 2000-char chunks
    for (let i = 0; i < text.length; i += DISCORD_MSG_LIMIT) {
      await channel.send(text.slice(i, i + DISCORD_MSG_LIMIT));
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.client.destroy();
    logger.info('Discord disconnected');
  }
}
