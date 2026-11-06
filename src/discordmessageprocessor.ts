/*
Copyright 2017 - 2019 matrix-appservice-discord

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import * as Discord from "@mx-puppet/better-discord.js";
import * as escapeHtml from "escape-html";
import { DiscordBot, IDiscordStickerItem } from "./bot";
import {
    DiscordMessageParser,
    IDiscordMessageParserOpts,
    IDiscordMessageParserCallbacks,
    IDiscordMessageParserResult,
} from "@mx-puppet/matrix-discord-parser";

const MXC_INSERT_REGEX = /\x01emoji\x01(\w+)\x01([01])\x01([0-9]*)\x01/;
const NAME_MXC_INSERT_REGEX_GROUP = 1;
const ANIMATED_MXC_INSERT_REGEX_GROUP = 2;
const ID_MXC_INSERT_REGEX_GROUP = 3;
const LOTTIE_FORMAT = 3;
const GIF_FORMAT = 4;

interface IMessageWithStickers extends Discord.Message {
    stickerItems?: IDiscordStickerItem[];
}

export class DiscordMessageProcessor {
    private parser: DiscordMessageParser;
    constructor(private domain: string, private bot: DiscordBot) {
        this.parser = new DiscordMessageParser();
        (this.parser as unknown as {
            InsertMxcImages: (
                opts: IDiscordMessageParserOpts,
                content: string,
                msg: Discord.Message,
                html?: boolean,
            ) => Promise<string>;
        }).InsertMxcImages = async (_opts, content, _msg, html = false) => {
            let results = MXC_INSERT_REGEX.exec(content);
            while (results !== null) {
                const name = results[NAME_MXC_INSERT_REGEX_GROUP];
                const animated = results[ANIMATED_MXC_INSERT_REGEX_GROUP] === "1";
                const id = results[ID_MXC_INSERT_REGEX_GROUP];
                const ext = animated ? "gif" : "png";
                const url = `https://cdn.discordapp.com/emojis/${id}.${ext}`;
                const nameHtml = escapeHtml(name);
                const replace = html
                    ? `<a href="${escapeHtml(url)}">:${nameHtml}:</a>`
                    : `[:${name}:](${url})`;
                content = content.replace(results[0], replace);
                results = MXC_INSERT_REGEX.exec(content);
            }
            return content;
        };
    }

    public async FormatMessage(msg: Discord.Message): Promise<IDiscordMessageParserResult> {
        const opts = {
            callbacks: this.getParserCallbacks(msg),
        } as IDiscordMessageParserOpts;
        const result = await this.parser.FormatMessage(opts, msg);
        const stickerItems = (msg as IMessageWithStickers).stickerItems || [];
        if (stickerItems.length > 0) {
            const displayName = msg.member?.displayName || msg.author?.username || "User";
            for (const sticker of stickerItems) {
                const stickerName = sticker.name || sticker.id;
                let stickerUrl: string;
                if (sticker.format_type === LOTTIE_FORMAT) {
                    stickerUrl = `https://discord.com/stickers/${sticker.id}.json`;
                } else {
                    const ext = sticker.format_type === GIF_FORMAT ? "gif" : "png";
                    stickerUrl = `https://media.discordapp.net/stickers/${sticker.id}.${ext}`;
                }
                const plainLine = `${displayName} sent a sticker: [${stickerName}](${stickerUrl})`;
                const htmlLine = `${escapeHtml(displayName)} sent a sticker: ` +
                    `<a href="${escapeHtml(stickerUrl)}">${escapeHtml(stickerName)}</a>`;
                result.body = result.body ? `${result.body}\n${plainLine}` : plainLine;
                result.formattedBody = result.formattedBody
                    ? `${result.formattedBody}<br>${htmlLine}`
                    : htmlLine;
            }
            if (!result.msgtype) {
                result.msgtype = msg.author?.bot ? "m.notice" : "m.text";
            }
        }
        return result;
    }

    public async FormatEdit(
        msg1: Discord.Message,
        msg2: Discord.Message,
        link: string,
    ): Promise<IDiscordMessageParserResult> {
        // obsolete once edit PR is merged
        const opts = {
            callbacks: this.getParserCallbacks(msg2),
        } as IDiscordMessageParserOpts;
        return await this.parser.FormatEdit(opts, msg1, msg2, link);
    }

    private getParserCallbacks(msg: Discord.Message): IDiscordMessageParserCallbacks {
        return {
            getChannel: async (id: string) => {
                const channel = msg.guild?.channels.resolve(id);
                if (!channel) {
                    return null;
                }
                const alias = await this.bot.ChannelSyncroniser.GetAliasFromChannel(channel);
                if (!alias) {
                    return null;
                }
                return {
                    mxid: alias,
                    name: channel.name,
                };
            },
            getEmoji: async (name: string, animated: boolean, id: string) => {
                const ext = animated ? "gif" : "png";
                return `https://cdn.discordapp.com/emojis/${id}.${ext}`;
            },
            getUser: async (id: string) => {
                const member = msg.guild?.members.resolve(id);
                const mxid = `@_discord_${id}:${this.domain}`;
                const name = member ? member.displayName : mxid;
                return {
                    mxid,
                    name,
                };
            },
        };
    }

}
