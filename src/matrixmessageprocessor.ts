/*
Copyright 2018, 2019 matrix-appservice-discord

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
import { IMatrixMessage } from "./matrixtypes";
import { Util } from "./util";
import { DiscordBot } from "./bot";
import { MatrixClient } from "matrix-bot-sdk";
import { DiscordBridgeConfig } from "./config";
import {
    IMatrixMessageParserCallbacks,
    IMatrixMessageParserOpts,
    MatrixMessageParser,
} from "@mx-puppet/matrix-discord-parser";

const DEFAULT_ROOM_NOTIFY_POWER_LEVEL = 50;

export interface IMatrixMessageProcessorParams {
    displayname?: string;
    mxClient?: MatrixClient;
    roomId?: string;
    userId?: string;
}

export class MatrixMessageProcessor {
    private parser: MatrixMessageParser;
    constructor(public bot: DiscordBot, private config: DiscordBridgeConfig) {
        this.parser = new MatrixMessageParser();
    }

    public async FormatMessage(
        msg: IMatrixMessage,
        guild: Discord.Guild,
        params?: IMatrixMessageProcessorParams,
    ): Promise<string> {
        const parseMsg: IMatrixMessage = msg.formatted_body
            ? {
                ...msg,
                formatted_body: msg.formatted_body.replace(/<\/p>\s*\r?\n\s*<p(\b|>)/gi, "</p><p$1"),
            }
            : msg;
        const opts = this.getParserOpts(parseMsg, guild, params);
        const reply = await this.parser.FormatMessage(opts, parseMsg);
        return reply.replace(/\\:([a-zA-Z0-9_\\]+)\\:/g, (match, rawName: string) => {
            const cleanName = rawName.replace(/\\_/g, "_");
            const emoji = this.findEmojiByName(cleanName, guild);
            if (emoji) {
                return `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`;
            }
            return match;
        });
    }

    private findEmojiByName(
        cleanName: string,
        guild: Discord.Guild,
    ): {id: string, animated: boolean, name: string} | null {
        const lower = cleanName.toLowerCase();
        let emoji = guild?.emojis?.cache?.find((e) => e.name === cleanName)
            || guild?.emojis?.cache?.find((e) => e.name?.toLowerCase() === lower)
            || guild?.emojis?.resolve(cleanName)
            || null;
        if (!emoji && this.bot && typeof this.bot.GetGuilds === "function") {
            try {
                for (const g of this.bot.GetGuilds()) {
                    emoji = g.emojis?.cache?.find((e) => e.name === cleanName)
                        || g.emojis?.cache?.find((e) => e.name?.toLowerCase() === lower)
                        || null;
                    if (emoji) {
                        break;
                    }
                }
            } catch (err) { } // ignore if bot is not connected
        }
        return emoji;
    }

    private getParserOpts(
        msg: IMatrixMessage,
        guild: Discord.Guild,
        params?: IMatrixMessageProcessorParams,
    ): IMatrixMessageParserOpts {
        return {
            callbacks: this.getParserCallbacks(msg, guild, params),
            determineCodeLanguage: this.config.bridge.determineCodeLanguage,
            displayname: params ? params.displayname || "" : "",
            urlShortener: {},
        };
    }

    private getParserCallbacks(
        msg: IMatrixMessage,
        guild: Discord.Guild,
        params?: IMatrixMessageProcessorParams,
    ): IMatrixMessageParserCallbacks {
        return {
            canNotifyRoom: async () => {
                if (!params || !params.mxClient || !params.roomId || !params.userId) {
                    return false;
                }
                return await Util.CheckMatrixPermission(
                    params.mxClient,
                    params.userId,
                    params.roomId,
                    DEFAULT_ROOM_NOTIFY_POWER_LEVEL,
                    "notifications",
                    "room",
                );
            },
            getChannelId: async (mxid: string) => {
                const CHANNEL_REGEX = /^#_discord_[0-9]*_([0-9]*):/;
                const match = mxid.match(CHANNEL_REGEX);
                const channel = match && guild.channels.resolve(match[1]);
                if (!channel) {
                    /*
                    This isn't formatted in #_discord_, so let's fetch the internal room ID
                    and see if it is still a bridged room!
                    */
                    if (params && params.mxClient) {
                        try {
                            const resp = await params.mxClient.lookupRoomAlias(mxid);
                            if (resp && resp.roomId) {
                                const roomId = resp.roomId;
                                const ch = await this.bot.GetChannelFromRoomId(roomId);
                                return ch.id;
                            }
                        } catch (err) { } // ignore, room ID wasn't found
                    }
                    return null;
                }
                return match && match[1] || null;
            },
            getEmoji: async (mxc: string, name: string) => {
                let emoji: {id: string, animated: boolean, name: string} | null = null;
                if (mxc && mxc.startsWith("mxc://")) {
                    try {
                        const emojiDb = await this.bot.GetEmojiByMxc(mxc);
                        const id = emojiDb.EmojiId;
                        emoji = guild.emojis.resolve(id) || {
                            animated: emojiDb.Animated,
                            id: emojiDb.EmojiId,
                            name: emojiDb.Name,
                        };
                    } catch (e) {
                        emoji = null;
                    }
                }
                if (!emoji && name) {
                    const cleanName = name.replace(/^:+|:+$/g, "");
                    if (cleanName) {
                        emoji = this.findEmojiByName(cleanName, guild);
                    }
                }
                return emoji;
            },
            getUserId: async (mxid: string) => {
                const USER_REGEX = /^@_discord_([0-9]*)/;
                const match = mxid.match(USER_REGEX);
                const member = match && await guild.members.fetch(match[1]);
                if (!match || !member) {
                    return null;
                }
                return match[1];
            },
            mxcUrlToHttp: (mxc: string) => {
                if (params && params.mxClient && mxc.startsWith("mxc://")) {
                    return params.mxClient.mxcToHttp(mxc);
                }
                return mxc;
            },
        };
    }
}
