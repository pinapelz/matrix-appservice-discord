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
import { IDiscordMessageParserResult } from "@mx-puppet/matrix-discord-parser";
import { DiscordBridgeConfig } from "./config";
import { DiscordClientFactory } from "./clientfactory";
import { DiscordStore } from "./store";
import { DbEmoji } from "./db/dbdataemoji";
import { DbEvent } from "./db/dbdataevent";
import { DbReaction, DbReactionThread } from "./db/dbdatareaction";
import { DiscordMessageProcessor } from "./discordmessageprocessor";
import { MatrixEventProcessor, MatrixEventProcessorOpts, IMatrixEventProcessorResult } from "./matrixeventprocessor";
import { PresenceHandler } from "./presencehandler";
import { Provisioner } from "./provisioner";
import { UserSyncroniser } from "./usersyncroniser";
import { ChannelSyncroniser } from "./channelsyncroniser";
import { MatrixRoomHandler } from "./matrixroomhandler";
import { Log } from "./log";
import * as mime from "mime";
import { IMatrixEvent, IMatrixMediaInfo, IMatrixMessage } from "./matrixtypes";
import { Appservice, Intent, MatrixClient } from "matrix-bot-sdk";
import { DiscordCommandHandler } from "./discordcommandhandler";
import { MetricPeg } from "./metrics";
import { Lock } from "./structures/lock";
import { Util } from "./util";
import { BridgeBlocker, UserActivityState, UserActivityTracker } from "matrix-appservice-bridge";

const log = new Log("DiscordBot");

const MIN_PRESENCE_UPDATE_DELAY = 250;
const TYPING_TIMEOUT_MS = 30 * 1000;
const CACHE_LIFETIME = 90000;
const LOTTIE_FORMAT = 3;
const GIF_FORMAT = 4;
const STICKER_SIZE = 160;
const AUTO_ARCHIVE_MINUTES = 60;
const SUPPRESS_NOTIFICATIONS_FLAG = 4096;

// how often do we retry to connect on startup
const INITIAL_FALLOFF_SECONDS = 5;
const MAX_FALLOFF_SECONDS = 5 * 60; // 5 minutes

// TODO: This is bad. We should be serving the icon from the own homeserver.
const MATRIX_ICON_URL = "https://matrix.org/_matrix/media/r0/download/matrix.org/mlxoESwIsTbJrfXyAAogrNxA";
class ChannelLookupResult {
    public channel: Discord.TextChannel;
    public botUser: boolean;
    public canSendEmbeds: boolean;
}

interface IThirdPartyLookupField {
    channel_id: string;
    channel_name: string;
    guild_id: string;
}

export interface IThirdPartyLookup {
    alias: string;
    fields: IThirdPartyLookupField;
    protocol: string;
}

export interface IDiscordStickerItem {
    id: string;
    name: string;
    // eslint-disable-next-line @typescript-eslint/naming-convention
    format_type?: number;
}

interface IRawDiscordMessageData {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    sticker_items?: IDiscordStickerItem[];
    stickers?: IDiscordStickerItem[];
    type?: number;
    // eslint-disable-next-line @typescript-eslint/naming-convention
    message_reference?: {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        channel_id?: string;
        // eslint-disable-next-line @typescript-eslint/naming-convention
        guild_id?: string;
        // eslint-disable-next-line @typescript-eslint/naming-convention
        message_id?: string;
    };
    thread?: {
        id: string;
        name?: string;
        // eslint-disable-next-line @typescript-eslint/naming-convention
        parent_id?: string;
        type?: number;
    };
}

interface IPatchedDiscordMessage extends Discord.Message {
    stickerItems?: IDiscordStickerItem[];
    rawType?: number;
    thread?: {
        id: string;
        name?: string;
        // eslint-disable-next-line @typescript-eslint/naming-convention
        parent_id?: string;
        type?: number;
    };
    _patch?: (data: IRawDiscordMessageData) => void;
    __stickerPatched?: boolean;
}

const DISCORD_MSG_TYPE_THREAD_CREATED = 18;
const DISCORD_MSG_TYPE_REPLY = 19;
const DISCORD_MSG_TYPE_THREAD_STARTER = 21;
const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);

const messageProto = Discord.Message.prototype as unknown as IPatchedDiscordMessage;
if (messageProto._patch && !messageProto.__stickerPatched) {
    const origPatch = messageProto._patch;
    messageProto._patch = function(this: IPatchedDiscordMessage, data: IRawDiscordMessageData) {
        origPatch.call(this, data);
        if (data && ("sticker_items" in data || "stickers" in data)) {
            this.stickerItems = data.sticker_items || data.stickers || [];
        } else if (!Array.isArray(this.stickerItems)) {
            this.stickerItems = [];
        }
        if (data && typeof data.type === "number") {
            this.rawType = data.type;
            if (data.type === DISCORD_MSG_TYPE_REPLY) {
                (this as any).type = "REPLY";
                this.system = false;
            }
        }
        if (data && data.message_reference) {
            this.reference = {
                channelID: data.message_reference.channel_id || (this.channel ? this.channel.id : ""),
                guildID: data.message_reference.guild_id || (this.guild ? this.guild.id : ""),
                messageID: data.message_reference.message_id || null,
            };
        }
        if (data && data.thread) {
            this.thread = data.thread;
        }
    };
    messageProto.__stickerPatched = true;
}

const channelClass = Discord.Channel as any;
if (channelClass && typeof channelClass.create === "function" && !channelClass.__threadPatched) {
    const origChannelCreate = channelClass.create;
    channelClass.create = function(client: Discord.Client, data: any, guild?: Discord.Guild) {
        if (data && THREAD_CHANNEL_TYPES.has(data.type)) {
            const resolvedGuild = guild || (data.guild_id ? client.guilds?.cache?.get(data.guild_id) : undefined);
            if (resolvedGuild) {
                const TextChannelClass = Discord.Structures.get("TextChannel");
                const channel = new TextChannelClass(resolvedGuild, {
                    ...data,
                    type: 0,
                });
                (channel as any).isThreadChannel = true;
                (channel as any).threadType = data.type;
                channel.parentID = data.parent_id || null;
                return channel;
            }
        }
        return origChannelCreate.call(this, client, data, guild);
    };
    channelClass.__threadPatched = true;
}

const apiMessageProto = (Discord as any).APIMessage?.prototype;
if (apiMessageProto && typeof apiMessageProto.resolveData === "function" && !apiMessageProto.__replyPatched) {
    const origResolveData = apiMessageProto.resolveData;
    apiMessageProto.resolveData = function(this: any) {
        const res = origResolveData.call(this);
        if (this.options?.messageReference && this.data) {
            this.data.message_reference = this.options.messageReference;
        }
        return res;
    };
    apiMessageProto.__replyPatched = true;
}

class DiscordBridgeBlocker extends BridgeBlocker {
    constructor(userLimit: number, private bridge: DiscordBot) {
        super(userLimit);
    }

    async checkLimits(users: number) {
        await super.checkLimits(users);
        MetricPeg.get.setBridgeBlocked(this.isBlocked);
    }

    async blockBridge() {
        log.info("Blocking the bridge");
        await this.bridge.stop();
        await super.blockBridge();
    }

    async unblockBridge() {
        log.info("Unblocking the bridge");
        await super.unblockBridge();
        await this.bridge.run();
    }
}

export class DiscordBot {
    private clientFactory: DiscordClientFactory;
    private _bot: Discord.Client|undefined;
    private sentMessages: string[];
    private lastEventIds: { [channelId: string]: string };
    private notifiedDiscordThreads: Set<string>;
    private discordMsgProcessor: DiscordMessageProcessor;
    private mxEventProcessor: MatrixEventProcessor;
    private presenceHandler: PresenceHandler;
    private userSync!: UserSyncroniser;
    private channelSync: ChannelSyncroniser;
    private roomHandler: MatrixRoomHandler;
    private provisioner: Provisioner;
    private discordCommandHandler: DiscordCommandHandler;
    /* Caches */
    private roomIdsForGuildCache: Map<string, {roomIds: string[], ts: number}> = new Map();

    /* Handles messages queued up to be sent to matrix from discord. */
    private discordMessageQueue: { [channelId: string]: Promise<void> };
    private channelLock: Lock<string>;
    private typingTimers: Record<string, NodeJS.Timeout> = {}; // DiscordUser+channel -> Timeout

    private userActivity: UserActivityTracker;
    private bridgeBlocker?: DiscordBridgeBlocker;

    private get bot(): Discord.Client {
        if (!this._bot) {
            let bridgeBlocked = '';
            if (this.bridgeBlocker?.isBlocked) {
                bridgeBlocked = ' (bridge is blocked)';
            }
            throw new Error(`Bot is not connected to Discord${bridgeBlocked}`);
        }

        return this._bot!;
    }

    constructor(
        private config: DiscordBridgeConfig,
        private bridge: Appservice,
        private store: DiscordStore,
        private adminNotifier?: AdminNotifier,
    ) {

        // create handlers
        this.clientFactory = new DiscordClientFactory(store, config.auth);
        this.discordMsgProcessor = new DiscordMessageProcessor(config.bridge.domain, this);
        this.presenceHandler = new PresenceHandler(this);
        this.roomHandler = new MatrixRoomHandler(this, config, bridge, store.roomStore);
        this.channelSync = new ChannelSyncroniser(bridge, config, this, store.roomStore);
        this.provisioner = new Provisioner(store.roomStore, this.channelSync);
        this.mxEventProcessor = new MatrixEventProcessor(
            new MatrixEventProcessorOpts(config, bridge, this, store),
        );
        this.discordCommandHandler = new DiscordCommandHandler(bridge, this);
        // init vars
        this.sentMessages = [];
        this.discordMessageQueue = {};
        this.channelLock = new Lock(this.config.limits.discordSendDelay);
        this.lastEventIds = {};
        this.notifiedDiscordThreads = new Set();

        if (!this.adminNotifier && config.bridge.adminMxid) {
            this.adminNotifier = new AdminNotifier(
                this.bridge.botClient, config.bridge.adminMxid
            );
        }
    }

    get ClientFactory(): DiscordClientFactory {
        return this.clientFactory;
    }

    get UserSyncroniser(): UserSyncroniser {
        return this.userSync;
    }

    get ChannelSyncroniser(): ChannelSyncroniser {
        return this.channelSync;
    }

    get BotUserId(): string {
        return this.bridge.botUserId;
    }

    get RoomHandler(): MatrixRoomHandler {
        return this.roomHandler;
    }

    get MxEventProcessor(): MatrixEventProcessor {
        return this.mxEventProcessor;
    }

    get Provisioner(): Provisioner {
        return this.provisioner;
    }

    public GetIntentFromDiscordMember(member: Discord.GuildMember | Discord.PartialUser | Discord.User,
                                      webhookID: string|null = null): Intent {
        if (webhookID) {
            // webhookID and user IDs are the same, they are unique, so no need to prefix _webhook_
            const name = member instanceof Discord.GuildMember ? member.user.username : member.username;
            if (!name) {
                log.error("Couldn't get intent for Discord member, name was null:", member);
                throw Error("Couldn't get intent for Discord member, name was null");
            }
            // TODO: We need to sanitize name
            return this.bridge.getIntentForSuffix(`${webhookID}_${Util.EscapeStringForUserId(name)}`);
        }
        return this.bridge.getIntentForSuffix(member.id);
    }

    public async init(): Promise<void> {
        await this.clientFactory.init();
        // This immediately pokes UserStore, so it must be created after the bridge has started.
        this.userSync = new UserSyncroniser(this.bridge, this.config, this, this.store.userStore);

        this.userActivity = new UserActivityTracker(
            this.config.bridge.activityTracker,
            await this.store.getUserActivity(),
            async changes => this.onUserActivityChanged(changes),
        );
        const activeUsers = this.userActivity.countActiveUsers().allUsers;
        MetricPeg.get.setRemoteMonthlyActiveUsers(activeUsers);

        if (this.config.bridge.userLimit !== null) {
            log.info(`Bridge blocker is enabled with a user limit of ${this.config.bridge.userLimit}`);
            this.bridgeBlocker = new DiscordBridgeBlocker(this.config.bridge.userLimit, this);
            this.bridgeBlocker?.checkLimits(activeUsers).catch(err => {
                log.error(`Failed to check bridge limits: ${err}`);
            });
        }
    }

    public async run(): Promise<void> {
        if (this.bridgeBlocker?.isBlocked) {
            log.warn('Bridge is blocked, run() aborted');
            return;
        }
        const client = await this.clientFactory.getClient();
        if (!this.config.bridge.disableTypingNotifications) {
            client.on("typingStart", async (channel, user) => {
                try {
                    await this.OnTyping(channel, user, true);
                } catch (err) { log.warning("Exception thrown while handling \"typingStart\" event", err); }
            });
        }
        if (!this.config.bridge.disablePresence) {
            client.on("presenceUpdate", (_, newPresence) => {
                try {
                    this.presenceHandler.EnqueueUser(newPresence);
                } catch (err) { log.warning("Exception thrown while handling \"presenceUpdate\" event", err); }
            });
        }
        client.on("channelUpdate", async (_, newChannel) => {
            try {
                await this.channelSync.OnUpdate(newChannel);
            } catch (err) { log.error("Exception thrown while handling \"channelUpdate\" event", err); }
        });
        client.on("channelDelete", async (channel) => {
            try {
                await this.channelSync.OnDelete(channel);
            } catch (err) { log.error("Exception thrown while handling \"channelDelete\" event", err); }
        });
        client.on("guildUpdate", async (_, newGuild) => {
            try {
                await this.channelSync.OnGuildUpdate(newGuild);
            } catch (err) { log.error("Exception thrown while handling \"guildUpdate\" event", err); }
        });
        client.on("guildDelete", async (guild) => {
            try {
                await this.channelSync.OnGuildDelete(guild);
            } catch (err) { log.error("Exception thrown while handling \"guildDelete\" event", err); }
        });

        // Due to messages often arriving before we get a response from the send call,
        // messages get delayed from discord. We use Util.DelayedPromise to handle this.

        client.on("messageDelete", async (msg: Discord.Message) => {
            try {
                await this.channelLock.wait(msg.channel.id);
                this.clientFactory.bindMetricsToChannel(msg.channel as Discord.TextChannel);
                this.discordMessageQueue[msg.channel.id] = (async () => {
                    await (this.discordMessageQueue[msg.channel.id] || Promise.resolve());
                    try {
                        await this.DeleteDiscordMessage(msg);
                    } catch (err) {
                        log.error("Caught while handing 'messageDelete'", err);
                    }
                })();
            } catch (err) {
                log.error("Exception thrown while handling \"messageDelete\" event", err);
            }
        });
        client.on("messageDeleteBulk", async (msgs: Discord.Collection<Discord.Snowflake, Discord.Message>) => {
            try {
                await Util.DelayedPromise(this.config.limits.discordSendDelay);
                const promiseArr: (() => Promise<void>)[] = [];
                msgs.forEach((msg) => {
                    promiseArr.push(async () => {
                        try {
                            await this.channelLock.wait(msg.channel.id);
                            this.clientFactory.bindMetricsToChannel(msg.channel as Discord.TextChannel);
                            await this.DeleteDiscordMessage(msg);
                        } catch (err) {
                            log.error("Caught while handling 'messageDeleteBulk'", err);
                        }
                    });
                });
                await Promise.all(promiseArr);
            } catch (err) {
                log.error("Exception thrown while handling \"messageDeleteBulk\" event", err);
            }
        });
        client.on("messageUpdate", async (oldMessage: Discord.Message, newMessage: Discord.Message) => {
            try {
                await this.channelLock.wait(newMessage.channel.id);
                this.clientFactory.bindMetricsToChannel(newMessage.channel as Discord.TextChannel);
                this.discordMessageQueue[newMessage.channel.id] = (async () => {
                    await (this.discordMessageQueue[newMessage.channel.id] || Promise.resolve());
                    try {
                        await this.OnMessageUpdate(oldMessage, newMessage);
                    } catch (err) {
                        log.error("Caught while handing 'messageUpdate'", err);
                    }
                })();
            } catch (err) {
                log.error("Exception thrown while handling \"messageUpdate\" event", err);
            }
        });
        client.on("message", async (msg: Discord.Message) => {
            try {
                log.verbose(`Got incoming msg i:${msg.id} c:${msg.channel.id} g:${msg.guild?.id}`);
                MetricPeg.get.registerRequest(msg.id);
                await this.channelLock.wait(msg.channel.id);
                this.clientFactory.bindMetricsToChannel(msg.channel as Discord.TextChannel);
                this.discordMessageQueue[msg.channel.id] = (async () => {
                    await (this.discordMessageQueue[msg.channel.id] || Promise.resolve());
                    try {
                        await this.OnMessage(msg);
                    } catch (err) {
                        MetricPeg.get.requestOutcome(msg.id, true, "fail");
                        log.error("Caught while handing 'message'", err);
                    }
                })();
            } catch (err) {
                log.error("Exception thrown while handling \"message\" event", err);
            }
        });
        client.on("messageReactionAdd", async (reaction: Discord.MessageReaction, user: Discord.User | Discord.PartialUser) => {
            try {
                const chanId = reaction.message.channel.id;
                await this.channelLock.wait(chanId);
                this.discordMessageQueue[chanId] = (async () => {
                    await (this.discordMessageQueue[chanId] || Promise.resolve());
                    try {
                        await this.OnReactionAdd(reaction, user);
                    } catch (err) {
                        log.error("Caught while handling 'messageReactionAdd'", err);
                    }
                })();
            } catch (err) {
                log.error("Exception thrown while handling \"messageReactionAdd\" event", err);
            }
        });
        client.on("messageReactionRemove", async (reaction: Discord.MessageReaction, user: Discord.User | Discord.PartialUser) => {
            try {
                const chanId = reaction.message.channel.id;
                await this.channelLock.wait(chanId);
                this.discordMessageQueue[chanId] = (async () => {
                    await (this.discordMessageQueue[chanId] || Promise.resolve());
                    try {
                        await this.OnReactionRemove(reaction, user);
                    } catch (err) {
                        log.error("Caught while handling 'messageReactionRemove'", err);
                    }
                })();
            } catch (err) {
                log.error("Exception thrown while handling \"messageReactionRemove\" event", err);
            }
        });
        client.on("messageReactionRemoveEmoji", async (reaction: Discord.MessageReaction) => {
            try {
                const chanId = reaction.message.channel.id;
                await this.channelLock.wait(chanId);
                this.discordMessageQueue[chanId] = (async () => {
                    await (this.discordMessageQueue[chanId] || Promise.resolve());
                    try {
                        await this.OnReactionRemoveEmoji(reaction);
                    } catch (err) {
                        log.error("Caught while handling 'messageReactionRemoveEmoji'", err);
                    }
                })();
            } catch (err) {
                log.error("Exception thrown while handling \"messageReactionRemoveEmoji\" event", err);
            }
        });
        client.on("messageReactionRemoveAll", async (msg: Discord.Message | Discord.PartialMessage) => {
            try {
                const chanId = msg.channel.id;
                await this.channelLock.wait(chanId);
                this.discordMessageQueue[chanId] = (async () => {
                    await (this.discordMessageQueue[chanId] || Promise.resolve());
                    try {
                        await this.OnReactionRemoveAll(msg);
                    } catch (err) {
                        log.error("Caught while handling 'messageReactionRemoveAll'", err);
                    }
                })();
            } catch (err) {
                log.error("Exception thrown while handling \"messageReactionRemoveAll\" event", err);
            }
        });
        const jsLog = new Log("discord.js");

        client.on("userUpdate", async (_, user) => {
            try {
                if (!(user instanceof Discord.User)) {
                    log.warn(`Ignoring update for ${(<any>user).username}. User was partial.`);
                    return;
                }
                await this.userSync.OnUpdateUser(user);
            } catch (err) { log.error("Exception thrown while handling \"userUpdate\" event", err); }
        });
        client.on("guildMemberAdd", async (member) => {
            try {
                if (!(member instanceof Discord.GuildMember)) {
                    log.warn(`Ignoring update for ${(<any>member).guild?.id} ${(<any>member).id}. User was partial.`);
                    return;
                }
                await this.userSync.OnAddGuildMember(member);
            } catch (err) { log.error("Exception thrown while handling \"guildMemberAdd\" event", err); }
        });
        client.on("guildMemberRemove", async (member) =>  {
            try {
                if (!(member instanceof Discord.GuildMember)) {
                    log.warn(`Ignoring update for ${member.guild.id} ${member.id}. User was partial.`);
                    return;
                }
                await this.userSync.OnRemoveGuildMember(member);
            } catch (err) { log.error("Exception thrown while handling \"guildMemberRemove\" event", err); }
        });
        client.on("guildMemberUpdate", async (_, member) => {
            try {
                if (!(member instanceof Discord.GuildMember)) {
                    log.warn(`Ignoring update for ${(<any>member).guild.id} ${(<any>member).id}. User was partial.`);
                    return;
                }
                await this.userSync.OnUpdateGuildMember(member);
            } catch (err) { log.error("Exception thrown while handling \"guildMemberUpdate\" event", err); }
        });
        client.on("raw" as any, async (packet: any) => {
            try {
                if (!packet || !packet.t || !packet.d) {
                    return;
                }
                const channelsMgr = (client as any).channels;
                if (!channelsMgr || typeof channelsMgr.add !== "function") {
                    return;
                }
                if (packet.t === "GUILD_CREATE" && Array.isArray(packet.d.threads)) {
                    const guild = client.guilds?.cache?.get(packet.d.id);
                    for (const thread of packet.d.threads) {
                        channelsMgr.add(thread, guild);
                        if (thread.id) {
                            this.notifiedDiscordThreads.add(thread.id);
                        }
                    }
                } else if (packet.t === "THREAD_CREATE" || packet.t === "THREAD_UPDATE") {
                    const guild = packet.d.guild_id ? client.guilds?.cache?.get(packet.d.guild_id) : undefined;
                    channelsMgr.add(packet.d, guild);
                    if (
                        packet.t === "THREAD_CREATE" &&
                        packet.d.owner_id !== client.user?.id &&
                        packet.d.newly_created !== false
                    ) {
                        await this.NotifyDiscordThreadNotBridged(packet.d.id, packet.d.parent_id);
                    }
                } else if (packet.t === "THREAD_LIST_SYNC" && Array.isArray(packet.d.threads)) {
                    const guild = packet.d.guild_id ? client.guilds?.cache?.get(packet.d.guild_id) : undefined;
                    for (const thread of packet.d.threads) {
                        channelsMgr.add(thread, guild);
                    }
                } else if (
                    packet.t === "MESSAGE_CREATE" &&
                    packet.d.channel_id &&
                    !channelsMgr.cache?.has(packet.d.channel_id) &&
                    typeof channelsMgr.fetch === "function"
                ) {
                    const fetched = await channelsMgr.fetch(packet.d.channel_id);
                    if (fetched) {
                        (client as any).actions?.MessageCreate?.handle(packet.d);
                    }
                }
            } catch (err) {
                log.verbose("Exception while handling raw gateway packet", err);
            }
        });
        client.on("debug", (msg) => { jsLog.verbose(msg); });
        client.on("error", (msg) => { jsLog.error(msg); });
        client.on("warn", (msg) => { jsLog.warn(msg); });
        log.info("Discord bot client logged in.");
        this._bot = client;

        if (!this.config.bridge.disablePresence) {
            if (!this.config.bridge.presenceInterval) {
                this.config.bridge.presenceInterval = MIN_PRESENCE_UPDATE_DELAY;
            }
            this.bot.guilds.cache.forEach((guild) => {
                guild.members.cache.forEach((member) => {
                    if (member.id !== this.GetBotId()) {
                        this.presenceHandler.EnqueueUser(member.user.presence);
                    }
                });
            });
            await this.presenceHandler.Start(
                Math.max(this.config.bridge.presenceInterval, MIN_PRESENCE_UPDATE_DELAY),
            );
        }
    }

    public async start(): Promise<void> {
        return this._start(INITIAL_FALLOFF_SECONDS);
    }

    private async _start(falloffSeconds: number, isRetry = false): Promise<void> {
        try {
            await this.init();
            await this.run();
        } catch (err) {
            if (err.code === 'TOKEN_INVALID' && !isRetry) {
                await this.adminNotifier?.notify(this.config.bridge.invalidTokenMessage);
            }

            // no more than 5 minutes
            const newFalloffSeconds = Math.min(falloffSeconds * 2, MAX_FALLOFF_SECONDS);
            log.error(`Failed do start Discordbot: ${err.code}. Will try again in ${newFalloffSeconds} seconds`);
            await new Promise((r, _) => setTimeout(r, newFalloffSeconds * 1000));
            return this._start(newFalloffSeconds, true);
        }

        if (isRetry) {
            await this.adminNotifier?.notify(`The token situation is now resolved and the bridge is running correctly`);
        }
    }

    public async stop(): Promise<void> {
        this._bot = undefined;
    }

    public GetBotId(): string {
        // TODO: What do we do here?
        return this.bot.user!.id;
    }

    public GetGuilds(): Discord.Guild[] {
        return this.bot.guilds.cache.array();
    }

    public ThirdpartySearchForChannels(guildId: string, channelName: string): IThirdPartyLookup[] {
        if (channelName.startsWith("#")) {
            channelName = channelName.substring(1);
        }
        if (this.bot.guilds.cache.has(guildId) ) {
            const guild = this.bot.guilds.cache.get(guildId);
            return guild!.channels.cache.filter((channel) => {
                return channel.name.toLowerCase() === channelName.toLowerCase(); // Implement searching in the future.
            }).map((channel) => {
                return {
                    alias: `#_discord_${guild!.id}_${channel.id}:${this.config.bridge.domain}`,
                    fields: {
                        channel_id: channel.id,
                        channel_name: channel.name,
                        guild_id: guild!.id,
                    },
                    protocol: "discord",
                } as IThirdPartyLookup;
            });
        } else {
            log.info("Tried to do a third party lookup for a channel, but the guild did not exist");
            return [];
        }
    }

    public async LookupRoom(server: string, room: string, sender?: string): Promise<ChannelLookupResult> {
        const hasSender = sender !== null && sender !== undefined;
        try {
            const client = await this.clientFactory.getClient(sender);
            const guild = client.guilds.resolve(server);
            if (!guild) {
                throw new Error(`Guild "${server}" not found`);
            }
            const channel = guild.channels.resolve(room);
            if (channel && channel.type === "text") {
                if (hasSender) {
                    const permissions = guild.me && channel.permissionsFor(guild.me);
                    if (!permissions || !permissions.has("VIEW_CHANNEL") || !permissions.has("SEND_MESSAGES")) {
                        throw new Error(`Can't send into channel`);
                    }
                }

                this.ClientFactory.bindMetricsToChannel(channel as Discord.TextChannel);
                const lookupResult = new ChannelLookupResult();
                lookupResult.channel = channel as Discord.TextChannel;
                lookupResult.botUser = this.bot.user?.id === client.user?.id;
                lookupResult.canSendEmbeds = client.user?.bot || false; // only bots can send embeds
                return lookupResult;
            }
            throw new Error(`Channel "${room}" not found`);
        } catch (err) {
            log.verbose("LookupRoom => ", err);
            if (hasSender) {
                log.verbose(`Couldn't find guild/channel under user account. Falling back.`);
                return await this.LookupRoom(server, room);
            }
            throw err;
        }
    }

    public async sendAsBot(msg: string, channel: Discord.TextChannel, event: IMatrixEvent): Promise<void> {
        if (!msg) {
            return;
        }
        this.channelLock.set(channel.id);
        const res = await channel.send(msg);
        await this.StoreMessagesSent(res, channel, event);
        this.channelLock.release(channel.id);
    }

    /**
     * Edits an event on Discord.
     * @throws {Unstable.ForeignNetworkError}
     */
    public async edit(
        embedSet: IMatrixEventProcessorResult,
        opts: Discord.MessageOptions,
        roomLookup: ChannelLookupResult,
        event: IMatrixEvent,
        editEventId: string,
    ): Promise<void> {
        const chan = roomLookup.channel;
        const botUser = roomLookup.botUser;
        const embed = embedSet.messageEmbed;
        let oldMsg: Discord.Message | undefined;
        try {
            oldMsg = await chan.messages.fetch(editEventId);
        } catch (err) {
            oldMsg = undefined;
        }
        if (!oldMsg) {
            // old message not found, just sending this normally
            await this.send(embedSet, opts, roomLookup, event);
            return;
        }
        if (!botUser) {
            try {
                if (!roomLookup.canSendEmbeds) {
                    await oldMsg.edit(this.prepareEmbedSetUserAccount(embedSet), opts);
                } else {
                    opts.embed = this.prepareEmbedSetBotAccount(embedSet);
                    await oldMsg.edit(embed.description, opts);
                }
                return;
            } catch (err) {
                log.warning("Failed to edit discord message, falling back to delete and resend...", err);
            }
        }
        try {
            if (editEventId === this.lastEventIds[chan.id]) {
                log.info("Immediate edit, deleting and re-sending");
                this.channelLock.set(chan.id);
                // we need to delete the event off of the store
                // else the delete bridges over back to matrix
                const dbEvent = await this.store.Get(DbEvent, { discord_id: editEventId });
                log.verbose("Event to delete", dbEvent);
                if (dbEvent && dbEvent.Next()) {
                    await this.store.Delete(dbEvent);
                }
                await oldMsg.delete();
                this.channelLock.release(chan.id);
                const msg = await this.send(embedSet, opts, roomLookup, event, true);
                // we re-insert the old matrix event with the new discord id
                // to allow consecutive edits, as matrix edits are typically
                // done on the original event
                const dummyEvent = {
                    event_id: event.content!["m.relates_to"].event_id,
                    room_id: event.room_id,
                } as IMatrixEvent;
                this.StoreMessagesSent(msg, chan, dummyEvent).catch(() => {
                    log.warn("Failed to store edit sent message for ", event.event_id);
                });
                return;
            }
            const link = `https://discord.com/channels/${chan.guild.id}/${chan.id}/${editEventId}`;
            embedSet.messageEmbed.description = `[Edit](${link}): ${embedSet.messageEmbed.description}`;
            await this.send(embedSet, opts, roomLookup, event);
        } catch (err) {
            if (opts.files && opts.files.length > 0) {
                throw err;
            }
            // throw wrapError(err, Unstable.ForeignNetworkError, "Couldn't edit message");
            log.warn(`Failed to edit message ${event.event_id}`);
            log.verbose(err);
        }
    }

    /**
     * Sends an event to Discord.
     * @throws {Unstable.ForeignNetworkError}
     */
    public async send(
        embedSet: IMatrixEventProcessorResult,
        opts: Discord.MessageOptions,
        roomLookup: ChannelLookupResult,
        event: IMatrixEvent,
        awaitStore: boolean = false,
    ): Promise<Discord.Message | null | (Discord.Message | null)[]> {
        const chan = roomLookup.channel;
        const botUser = roomLookup.botUser;
        const embed = embedSet.messageEmbed;

        let msg: Discord.Message | null | (Discord.Message | null)[] = null;
        let hook: Discord.Webhook | undefined;
        if (botUser) {
            const webhooks = await chan.fetchWebhooks();
            hook = webhooks.filter((h) => h.name === "_matrix").first();
            // Create a new webhook if none already exists
            try {
                if (!hook) {
                    hook = await chan.createWebhook(
                        "_matrix",
                        {
                            reason: "Matrix Bridge: Allow rich user messages",
                        });
                }
            } catch (err) {
               // throw wrapError(err, Unstable.ForeignNetworkError, "Unable to create \"_matrix\" webhook");
               log.warn("Unable to create _matrix webook:", err);
            }
        }
        try {
            this.channelLock.set(chan.id);
            if (!roomLookup.canSendEmbeds) {
                // NOTE: Don't send replies to discord if we are a puppet user.
                msg = await chan.send(this.prepareEmbedSetUserAccount(embedSet), opts);
            } else if (!botUser) {
                opts.embed = this.prepareEmbedSetBotAccount(embedSet);
                msg = await chan.send(embed.description, opts);
            } else if (hook) {
                MetricPeg.get.remoteCall("hook.send");
                const embeds = this.prepareEmbedSetWebhook(embedSet);
                // Enforce Discord webhook username limits (1-80 chars, no 'clyde' or 'discord')
                let cleanUsername = (embed!.author!.name || "TeamSpeak User")
                    .replace(/discord|clyde/gi, "")
                    .trim();

                if (cleanUsername.length === 0) {
                    cleanUsername = "TeamSpeak User";
                }
                cleanUsername = cleanUsername.slice(0, 80);

                msg = await hook.send(embed.description, {
                    avatarURL: embed!.author!.iconURL,
                    embeds,
                    files: opts.files,
                    username: cleanUsername,
                });
            } else {
                opts.embed = this.prepareEmbedSetBot(embedSet);
                msg = await chan.send("", opts);
            }
            // Don't block on this.
            const storePromise = this.StoreMessagesSent(msg, chan, event).then(() => {
                this.channelLock.release(chan.id);
            }).catch(() => {
                log.warn("Failed to store sent message for ", event.event_id);
            });
            if (awaitStore) {
                await storePromise;
            }
        } catch (err) {
            this.channelLock.release(chan.id);
            if (opts.files && opts.files.length > 0) {
                throw err;
            }
            // throw wrapError(err, Unstable.ForeignNetworkError, "Couldn't send message");
            log.warn(`Failed to send message ${event.event_id}`);
            log.verbose(err);
        }
        return msg;
    }

    public async ProcessMatrixReaction(
        event: IMatrixEvent,
        guildId: string,
        channelId: string,
        targetMatrixEventId: string,
        displayName: string,
        emojiKey: string,
        emojiDisplay: string,
    ) {
        const storeEvent = await this.store.Get(DbEvent, {
            matrix_id: `${targetMatrixEventId};${event.room_id}`,
        });
        if (!storeEvent || !storeEvent.Result || !storeEvent.Next()) {
            log.verbose(`Ignoring Matrix reaction for unbridged event ${targetMatrixEventId}`);
            return;
        }
        const discordMsgId = storeEvent.DiscordId;
        const resolvedChannelId = storeEvent.ChannelId || channelId;
        const resolvedGuildId = storeEvent.GuildId || guildId;

        const reaction = new DbReaction();
        reaction.DiscordMsgId = discordMsgId;
        reaction.RoomId = event.room_id;
        reaction.Source = "matrix";
        reaction.UserId = event.sender;
        reaction.DisplayName = displayName;
        reaction.EmojiKey = emojiKey;
        reaction.EmojiDisplay = emojiDisplay;
        reaction.EmojiMxc = "";
        reaction.MatrixReactionEventId = event.event_id;
        await this.store.Insert(reaction);

        await this.UpdateDiscordReactionSummary(
            discordMsgId,
            targetMatrixEventId,
            event.room_id,
            resolvedChannelId,
            resolvedGuildId,
        );
    }

    public async ProcessMatrixRedact(event: IMatrixEvent) {
        if (this.config.bridge.disableDeletionForwarding) {
            return;
        }
        log.info(`Got redact request for ${event.redacts}`);
        log.verbose(`Event:`, event);

        const reactionEvent = await this.store.Get(DbReaction, {
            matrix_reaction_event_id: event.redacts,
            room_id: event.room_id,
        });
        if (reactionEvent && reactionEvent.Result) {
            while (reactionEvent.Next()) {
                await this.store.Delete(reactionEvent);
                const threadRow = await this.store.Get(DbReactionThread, {
                    discord_msg_id: reactionEvent.DiscordMsgId,
                    room_id: event.room_id,
                });
                const storeMsgEvent = await this.store.Get(DbEvent, {
                    discord_id: reactionEvent.DiscordMsgId,
                });
                let channelId = threadRow?.ChannelId || "";
                let guildId = threadRow?.GuildId || "";
                let matrixMsgId = threadRow?.MatrixMsgId || "";
                if ((!channelId || !matrixMsgId) && storeMsgEvent && storeMsgEvent.Result && storeMsgEvent.Next()) {
                    channelId = channelId || storeMsgEvent.ChannelId;
                    guildId = guildId || storeMsgEvent.GuildId;
                    matrixMsgId = matrixMsgId || storeMsgEvent.MatrixId.split(";")[0];
                }
                if (channelId) {
                    await this.UpdateDiscordReactionSummary(
                        reactionEvent.DiscordMsgId,
                        matrixMsgId,
                        event.room_id,
                        channelId,
                        guildId,
                    );
                }
            }
            return;
        }

        const storeEvent = await this.store.Get(DbEvent, {matrix_id: `${event.redacts};${event.room_id}`});

        if (!storeEvent || !storeEvent.Result) {
            log.warn(`Could not redact because the event was not in the store.`);
            return;
        }
        log.info(`Redact event matched ${storeEvent.ResultCount} entries`);
        while (storeEvent.Next()) {
            log.info(`Deleting discord msg ${storeEvent.DiscordId}`);
            const result = await this.LookupRoom(storeEvent.GuildId, storeEvent.ChannelId, event.sender);
            const chan = result.channel;

            const msg = await chan.messages.fetch(storeEvent.DiscordId);
            try {
                this.channelLock.set(msg.channel.id);
                await msg.delete();
                this.channelLock.release(msg.channel.id);
                log.info(`Deleted message`);
            } catch (ex) {
                log.warn(`Failed to delete message`, ex);
            }
        }
    }

    public OnUserQuery(userId: string): boolean {
        return false;
    }

    public async GetDiscordUserOrMember(
        userId: Discord.Snowflake, guildId?: Discord.Snowflake,
    ): Promise<Discord.User|Discord.GuildMember|undefined> {
        try {
            const guild = guildId && await this.bot.guilds.fetch(guildId);
            if (guild) {
                return await guild.members.fetch(userId);
            }
            return await this.bot.users.fetch(userId);
        } catch (ex) {
            log.warn(`Could not fetch user data for ${userId} (guild: ${guildId})`);
            return undefined;
        }
    }

    public async GetChannelFromRoomId(roomId: string, client?: Discord.Client): Promise<Discord.Channel> {
        const entries = await this.store.roomStore.getEntriesByMatrixId(
            roomId,
        );

        if (!client) {
            client = this.bot;
        }

        if (entries.length === 0) {
            log.verbose(`Couldn"t find channel for roomId ${roomId}.`);
            throw Error("Room(s) not found.");
        }
        const entry = entries[0];
        if (!entry.remote) {
            throw Error("Room had no remote component");
        }
        const guild = await client.guilds.fetch(entry.remote!.get("discord_guild") as string);
        if (guild) {
            const channel = await client.channels.fetch(entry.remote!.get("discord_channel") as string);
            if (channel) {
                this.ClientFactory.bindMetricsToChannel(channel as Discord.TextChannel);
                return channel;
            }
            throw Error("Channel given in room entry not found");
        }
        throw Error("Guild given in room entry not found");
    }

    public async GetEmoji(name: string, animated: boolean, id: string): Promise<string> {
        if (!id.match(/^\d+$/)) {
            throw new Error("Non-numerical ID");
        }
        const dbEmoji = await this.store.Get(DbEmoji, {emoji_id: id});
        if (!dbEmoji) {
            throw new Error("Couldn't fetch from store");
        }
        if (!dbEmoji.Result) {
            const url = `https://cdn.discordapp.com/emojis/${id}${animated ? ".gif" : ".png"}`;
            const intent = this.bridge.botIntent;
            const content = (await Util.DownloadFile(url)).buffer;
            const type = animated ? "image/gif" : "image/png";
            const mxcUrl = await this.bridge.botIntent.underlyingClient.uploadContent(content, type, name);
            dbEmoji.EmojiId = id;
            dbEmoji.Name = name;
            dbEmoji.Animated = animated;
            dbEmoji.MxcUrl = mxcUrl;
            await this.store.Insert(dbEmoji);
        }
        return dbEmoji.MxcUrl;
    }

    public async GetRoomIdsFromGuild(
            guild: Discord.Guild, member?: Discord.GuildMember, useCache: boolean = true): Promise<string[]> {
        if (useCache) {
            const res = this.roomIdsForGuildCache.get(`${guild.id}:${member ? member.id : ""}`);

            if (res && res.ts > Date.now() - CACHE_LIFETIME) {
                return res.roomIds;
            }
        }

        if (member) {
            let rooms: string[] = [];
            await Util.AsyncForEach(guild.channels.cache.array(), async (channel) => {
                if (channel.type !== "text" || !channel.members.has(member.id)) {
                    return;
                }
                try {
                    rooms = rooms.concat(await this.channelSync.GetRoomIdsFromChannel(channel));
                } catch (e) { } // no bridged rooms for this channel
            });
            if (rooms.length === 0) {
                log.verbose(`No rooms were found for this guild and member (guild:${guild.id} member:${member.id})`);
                throw new Error("Room(s) not found.");
            }
            this.roomIdsForGuildCache.set(`${guild.id}:${guild.member}`, {roomIds: rooms, ts: Date.now()});
            return rooms;
        } else {
            const rooms = await this.store.roomStore.getEntriesByRemoteRoomData({
                discord_guild: guild.id,
            });
            if (rooms.length === 0) {
                log.verbose(`Couldn't find room(s) for guild id:${guild.id}.`);
                throw new Error("Room(s) not found.");
            }
            const roomIds = rooms.map((room) => room.matrix!.getId());
            this.roomIdsForGuildCache.set(`${guild.id}:`, {roomIds, ts: Date.now()});
            return roomIds;
        }
    }

    public async HandleMatrixKickBan(
        roomId: string, kickeeUserId: string, kicker: string, kickban: "leave"|"ban",
        previousState: string, reason?: string,
    ) {
        const restore = kickban === "leave" && previousState === "ban";
        const client = await this.clientFactory.getClient(kicker);
        let channel: Discord.Channel;
        try {
            channel = await this.GetChannelFromRoomId(roomId, client);
        } catch (ex) {
            log.error("Failed to get channel for ", roomId, ex);
            return;
        }
        if (channel.type !== "text") {
            log.warn("Channel was not a text channel");
            return;
        }
        const tchan = (channel as Discord.TextChannel);
        const kickeeUser = await this.GetDiscordUserOrMember(
            kickeeUserId.substring("@_discord_".length, kickeeUserId.indexOf(":") - 1),
            tchan.guild.id,
        );
        if (!kickeeUser) {
            log.error("Could not find discord user for", kickeeUserId);
            return;
        }
        const kickee = kickeeUser as Discord.GuildMember;
        let res: Discord.Message;
        const botChannel = await this.GetChannelFromRoomId(roomId) as Discord.TextChannel;
        if (restore) {
            await tchan.overwritePermissions([
                {
                    allow: ["SEND_MESSAGES", "VIEW_CHANNEL"],
                    id: kickee.id,
                }],
                `Unbanned.`,
            );
            this.channelLock.set(botChannel.id);
            res = await botChannel.send(
                `${kickee} was unbanned from this channel by ${kicker}.`,
            ) as Discord.Message;
            this.sentMessages.push(res.id);
            this.channelLock.release(botChannel.id);
            return;
        }
        const existingPerms = tchan.permissionsFor(kickee);
        if (existingPerms && existingPerms.has(Discord.Permissions.FLAGS.VIEW_CHANNEL as number) === false ) {
            log.warn("User isn't allowed to read anyway.");
            return;
        }
        const word = `${kickban === "ban" ? "banned" : "kicked"}`;
        this.channelLock.set(botChannel.id);
        res = await botChannel.send(
            `${kickee} was ${word} from this channel by ${kicker}.`
            + (reason ? ` Reason: ${reason}` : ""),
        ) as Discord.Message;
        this.sentMessages.push(res.id);
        this.channelLock.release(botChannel.id);
        log.info(`${word} ${kickee}`);

        await tchan.overwritePermissions([
            {
                deny: ["SEND_MESSAGES", "VIEW_CHANNEL"],
                id: kickee.id,
            }],
            `Matrix user was ${word} by ${kicker}.`,
        );
        if (kickban === "leave") {
            // Kicks will let the user back in after ~30 seconds.
            setTimeout(async () => {
                log.info(`Kick was lifted for ${kickee.displayName}`);
                await tchan.overwritePermissions([
                    {
                        allow: ["SEND_MESSAGES", "VIEW_CHANNEL"],
                        id: kickee.id,
                    }],
                    `Lifting kick since duration expired.`,
                );
            }, this.config.room.kickFor);
        }
    }

    public async GetEmojiByMxc(mxc: string): Promise<DbEmoji> {
        const dbEmoji = await this.store.Get(DbEmoji, {mxc_url: mxc});
        if (!dbEmoji || !dbEmoji.Result) {
            throw new Error("Couldn't fetch from store");
        }
        return dbEmoji;
    }

    private prepareEmbedSetUserAccount(embedSet: IMatrixEventProcessorResult): string {
        const embed = embedSet.messageEmbed;
        let addText = "";
        if (embedSet.replyEmbed) {
            for (const line of embedSet.replyEmbed.description!.split("\n")) {
                addText += "\n> " + line;
            }
        }
        return embed.description += addText;
    }

    private prepareEmbedSetBotAccount(embedSet: IMatrixEventProcessorResult): Discord.MessageEmbed | undefined {
        if (!embedSet.imageEmbed && !embedSet.replyEmbed) {
            return undefined;
        }
        let sendEmbed = new Discord.MessageEmbed();
        if (embedSet.imageEmbed) {
            if (!embedSet.replyEmbed) {
                sendEmbed = embedSet.imageEmbed;
            } else {
                sendEmbed.setImage(embedSet.imageEmbed.image!.url);
            }
        }
        if (embedSet.replyEmbed) {
            if (!embedSet.imageEmbed) {
                sendEmbed = embedSet.replyEmbed;
            } else {
                sendEmbed.addField("Replying to", embedSet.replyEmbed!.author!.name);
                sendEmbed.addField("Reply text", embedSet.replyEmbed.description);
            }
        }
        return sendEmbed;
    }

    private prepareEmbedSetWebhook(embedSet: IMatrixEventProcessorResult): Discord.MessageEmbed[] {
        const embeds: Discord.MessageEmbed[] = [];
        if (embedSet.imageEmbed) {
            embeds.push(embedSet.imageEmbed);
        }
        if (embedSet.replyEmbed) {
            embeds.push(embedSet.replyEmbed);
        }
        return embeds;
    }

    private prepareEmbedSetBot(embedSet: IMatrixEventProcessorResult): Discord.MessageEmbed {
        const embed = embedSet.messageEmbed;
        if (embedSet.imageEmbed) {
            embed.setImage(embedSet.imageEmbed.image!.url);
        }
        if (embedSet.replyEmbed) {
            embed.addField("Replying to", embedSet.replyEmbed!.author!.name);
            embed.addField("Reply text", embedSet.replyEmbed.description);
        }
        return embed;
    }

    private async SendMatrixMessage(matrixMsg: IDiscordMessageParserResult, chan: Discord.Channel,
                                    guild: Discord.Guild, author: Discord.User,
                                    msgID: string): Promise<boolean> {
        const rooms = await this.channelSync.GetRoomIdsFromChannel(chan);
        const intent = this.GetIntentFromDiscordMember(author);

        await Util.AsyncForEach(rooms, async (roomId) => {
            const eventId = await intent.sendEvent(roomId, {
                body: matrixMsg.body,
                format: "org.matrix.custom.html",
                formatted_body: matrixMsg.formattedBody,
                msgtype: "m.text",
            });
            this.lastEventIds[roomId] = eventId;
            const evt = new DbEvent();
            evt.MatrixId = `${eventId};${roomId}`;
            evt.DiscordId = msgID;
            evt.ChannelId = chan.id;
            evt.GuildId = guild.id;
            await this.store.Insert(evt);
            this.userActivity.updateUserActivity(intent.userId);
        });

        // Sending was a success
        return true;
    }

    private async OnTyping(channel: Discord.Channel, user: Discord.User|Discord.PartialUser, isTyping: boolean) {
        const rooms = await this.channelSync.GetRoomIdsFromChannel(channel);
        try {
            const intent = this.GetIntentFromDiscordMember(user);
            await intent.ensureRegistered();
            this.userActivity.updateUserActivity(intent.userId);
            await Promise.all(rooms.map( async (roomId) => {
                return intent.underlyingClient.setTyping(roomId, isTyping);
            }));
            const typingKey = `${user.id}:${channel.id}`;
            if (isTyping) {
                if (this.typingTimers[typingKey]) {
                    clearTimeout(this.typingTimers[typingKey]);
                }
                this.typingTimers[typingKey] = setTimeout(async () => {
                    this.OnTyping(channel, user, false).catch((ex) => {
                        log.error(`Failed to reset typing after ${TYPING_TIMEOUT_MS}ms for ${user.id}`);
                    });
                    delete this.typingTimers[typingKey];
                }, TYPING_TIMEOUT_MS);
            }
        } catch (err) {
            log.warn("Failed to send typing indicator.", err);
        }
    }

    private async FindMatrixEventIdInRoom(discordId: string, room: string): Promise<string | undefined> {
        if (!discordId || typeof this.store?.Get !== "function") {
            return undefined;
        }
        const storeEvent = await this.store.Get(DbEvent, { discord_id: discordId });
        if (!storeEvent || !storeEvent.Result) {
            return undefined;
        }
        let fallbackEventId: string | undefined;
        while (storeEvent.Next()) {
            const [matrixEventId, eventRoom] = storeEvent.MatrixId.split(";");
            if (eventRoom === room && matrixEventId) {
                return matrixEventId;
            }
            if (!fallbackEventId && matrixEventId && !eventRoom) {
                fallbackEventId = matrixEventId;
            }
        }
        return fallbackEventId;
    }

    private async NotifyDiscordThreadNotBridged(threadId: string, parentChannelId?: string | null): Promise<void> {
        if (!threadId || this.notifiedDiscordThreads.has(threadId)) {
            return;
        }
        let resolvedParentId = parentChannelId;
        if (!resolvedParentId) {
            const cachedChan = (this._bot as any)?.channels?.cache?.get(threadId);
            resolvedParentId = cachedChan?.parentID || cachedChan?.parent_id;
        }
        if (!resolvedParentId) {
            return;
        }
        try {
            const rooms = await this.channelSync.GetRoomIdsFromChannel({ id: resolvedParentId } as Discord.Channel);
            if (!rooms || rooms.length === 0) {
                return;
            }
        } catch (err) {
            return;
        }
        this.notifiedDiscordThreads.add(threadId);
        try {
            const msgRes = await Util.DiscordApiRequest(
                "POST",
                `/channels/${threadId}/messages`,
                this.config.auth.botToken,
                {
                    allowed_mentions: { parse: [] },
                    content: "WARNING! Threads are not bridged to Matrix.",
                },
            );
            if (msgRes?.id) {
                this.sentMessages.push(msgRes.id);
            }
        } catch (err) {
            log.warn(`Failed to send thread unsupported notice to Discord thread ${threadId}:`, err);
        }
    }

    private async ResolveDiscordMessageRelatesTo(msg: Discord.Message, room: string): Promise<any | undefined> {
        const refDiscordMsgId = msg.reference?.messageID || undefined;
        if (refDiscordMsgId) {
            const replyMatrixId = await this.FindMatrixEventIdInRoom(refDiscordMsgId, room);
            if (replyMatrixId) {
                return {
                    "m.in_reply_to": {
                        event_id: replyMatrixId,
                    },
                };
            }
        }
        return undefined;
    }

    private async RecordDiscordEventSentToMatrix(
        msg: Discord.Message,
        room: string,
        eventId: string,
        intentUserId: string,
    ): Promise<void> {
        this.lastEventIds[room] = eventId;
        const evt = new DbEvent();
        evt.MatrixId = `${eventId};${room}`;
        evt.DiscordId = msg.id;
        evt.ChannelId = msg.channel.id;
        if (msg.guild) {
            evt.GuildId = msg.guild.id;
        }
        await this.store.Insert(evt);
        this.userActivity?.updateUserActivity(intentUserId);
    }

    private async OnMessage(msg: Discord.Message, editEventId: string = "") {
        const indexOfMsg = this.sentMessages.indexOf(msg.id);
        if (indexOfMsg !== -1) {
            log.verbose("Got repeated message, ignoring.");
            delete this.sentMessages[indexOfMsg];
            MetricPeg.get.requestOutcome(msg.id, true, "dropped");
            return; // Skip *our* messages
        }
        const rawType = (msg as IPatchedDiscordMessage).rawType;
        if (rawType === DISCORD_MSG_TYPE_THREAD_CREATED || rawType === DISCORD_MSG_TYPE_THREAD_STARTER) {
            log.verbose(`Ignoring Discord thread system message ${msg.id} (type ${rawType})`);
            MetricPeg.get.requestOutcome(msg.id, true, "dropped");
            return;
        }
        const chan = msg.channel as Discord.TextChannel;
        if (msg.author.id === this.bot.user?.id) {
            // We don't support double bridging.
            log.verbose("Not reflecting bot's own messages");
            MetricPeg.get.requestOutcome(msg.id, true, "dropped");
            return;
        }
        if ((chan as any).isThreadChannel) {
            await this.NotifyDiscordThreadNotBridged(chan.id, chan.parentID);
            MetricPeg.get.requestOutcome(msg.id, true, "dropped");
            return;
        }
        // Test for webhooks
        if (msg.webhookID) {
            const webhook = (await chan.fetchWebhooks())
                            .filter((h) => h.name === "_matrix").first();
            if (webhook && msg.webhookID === webhook.id) {
                // Filter out our own webhook messages.
                log.verbose("Not reflecting own webhook messages");
                MetricPeg.get.requestOutcome(msg.id, true, "dropped");
                return;
            }
        }

        // check if it is a command to process by the bot itself
        if (msg.content.startsWith("!matrix")) {
            await this.discordCommandHandler.Process(msg);
            MetricPeg.get.requestOutcome(msg.id, true, "success");
            return;
        }

        // Update presence because sometimes discord misses people.
        await this.userSync.OnUpdateUser(msg.author, Boolean(msg.webhookID), msg);
        let rooms: string[];
        try {
            rooms = await this.channelSync.GetRoomIdsFromChannel(msg.channel);
            if (rooms === null) {
                throw Error();
            }
        } catch (err) {
            log.verbose("No bridged rooms to send message to. Oh well.");
            MetricPeg.get.requestOutcome(msg.id, true, "dropped");
            return null;
        }
        try {
            const intent = this.GetIntentFromDiscordMember(msg.author, msg.webhookID);
            // Check Attachements
            if (!editEventId) {
                // on discord you can't edit in images, you can only edit text
                // so it is safe to only check image upload stuff if we don't have
                // an edit
                await Util.AsyncForEach(msg.attachments.array(), async (attachment) => {
                    const content = await Util.DownloadFile(attachment.url);
                    const fileMime = content.mimeType || mime.getType(attachment.name || "")
                        || "application/octet-stream";
                    const mxcUrl = await intent.underlyingClient.uploadContent(
                        content.buffer,
                        fileMime,
                        attachment.name || "",
                    );
                    const type = fileMime.split("/")[0];
                    let msgtype = {
                        audio: "m.audio",
                        image: "m.image",
                        video: "m.video",
                    }[type];
                    if (!msgtype) {
                        msgtype = "m.file";
                    }
                    const info = {
                        mimetype: fileMime,
                        size: attachment.size,
                    } as IMatrixMediaInfo;
                    if (msgtype === "m.image" || msgtype === "m.video") {
                        info.w = attachment.width!;
                        info.h = attachment.height!;
                    }
                    await Util.AsyncForEach(rooms, async (room) => {
                        const relatesTo = await this.ResolveDiscordMessageRelatesTo(msg, room);
                        const attachmentContent: any = {
                            body: attachment.name || "file",
                            external_url: attachment.url,
                            info,
                            msgtype,
                            url: mxcUrl,
                        };
                        if (relatesTo) {
                            attachmentContent["m.relates_to"] = relatesTo;
                        }
                        const eventId = await intent.sendEvent(room, attachmentContent);
                        await this.RecordDiscordEventSentToMatrix(msg, room, eventId, intent.userId);
                    });
                });
                const stickerItems = (msg as IPatchedDiscordMessage).stickerItems || [];
                await Util.AsyncForEach(stickerItems, async (sticker) => {
                    const stickerName = sticker.name || sticker.id;
                    if (sticker.format_type === LOTTIE_FORMAT) {
                        const stickerUrl = `https://discord.com/stickers/${sticker.id}.json`;
                        await Util.AsyncForEach(rooms, async (room) => {
                            const relatesTo = await this.ResolveDiscordMessageRelatesTo(msg, room);
                            const lottieContent: any = {
                                body: `[${stickerName}](${stickerUrl})`,
                                format: "org.matrix.custom.html",
                                formatted_body: `<a href="${escapeHtml(stickerUrl)}">${escapeHtml(stickerName)}</a>`,
                                msgtype: msg.author?.bot ? "m.notice" : "m.text",
                            };
                            if (relatesTo) {
                                lottieContent["m.relates_to"] = relatesTo;
                            }
                            const eventId = await intent.sendEvent(room, lottieContent);
                            await this.RecordDiscordEventSentToMatrix(msg, room, eventId, intent.userId);
                        });
                        return;
                    }
                    const ext = sticker.format_type === GIF_FORMAT ? "gif" : "png";
                    const stickerUrl = `https://media.discordapp.net/stickers/${sticker.id}.${ext}`;
                    const content = await Util.DownloadFile(stickerUrl);
                    const fileMime = content.mimeType || (ext === "gif" ? "image/gif" : "image/png");
                    const mxcUrl = await intent.underlyingClient.uploadContent(
                        content.buffer,
                        fileMime,
                        `${stickerName}.${ext}`,
                    );
                    const info: IMatrixMediaInfo = {
                        h: STICKER_SIZE,
                        mimetype: fileMime,
                        size: content.buffer.byteLength,
                        w: STICKER_SIZE,
                    };
                    await Util.AsyncForEach(rooms, async (room) => {
                        await intent.ensureRegisteredAndJoined(room);
                        const relatesTo = await this.ResolveDiscordMessageRelatesTo(msg, room);
                        const stickerContent: any = {
                            body: stickerName,
                            info,
                            url: mxcUrl,
                        };
                        if (relatesTo) {
                            stickerContent["m.relates_to"] = relatesTo;
                        }
                        const eventId = await intent.underlyingClient.sendEvent(room, "m.sticker", stickerContent);
                        await this.RecordDiscordEventSentToMatrix(msg, room, eventId, intent.userId);
                    });
                });
            }
            if (!msg.content && msg.embeds.length === 0) {
                return;
            }
            const result = await this.discordMsgProcessor.FormatMessage(msg);
            if (!result.body) {
                return;
            }
            await Util.AsyncForEach(rooms, async (room) => {
                const sendContent: IMatrixMessage = {
                    body: result.body,
                    format: "org.matrix.custom.html",
                    formatted_body: result.formattedBody,
                    msgtype: result.msgtype,
                };
                if (editEventId) {
                    sendContent.body = `* ${result.body}`;
                    sendContent.formatted_body = `* ${result.formattedBody}`;
                    sendContent["m.new_content"] = {
                        body: result.body,
                        format: "org.matrix.custom.html",
                        formatted_body: result.formattedBody,
                        msgtype: result.msgtype,
                    };
                    sendContent["m.relates_to"] = {
                        event_id: editEventId,
                        rel_type: "m.replace",
                    };
                } else {
                    const relatesTo = await this.ResolveDiscordMessageRelatesTo(msg, room);
                    if (relatesTo) {
                        sendContent["m.relates_to"] = relatesTo;
                    }
                }
                const trySend = async () =>  intent.sendEvent(room, sendContent);
                const afterSend = async (eventId) => {
                    await this.RecordDiscordEventSentToMatrix(msg, room, eventId, intent.userId);
                };
                let res;
                try {
                    res = await trySend();
                    await afterSend(res);
                } catch (e) {
                    if (e.errcode !== "M_FORBIDDEN" && e.errcode !==  "M_GUEST_ACCESS_FORBIDDEN") {
                        log.error("Failed to send message into room.", e);
                        return;
                    }
                    if (msg.member && !msg.webhookID) {
                        await this.userSync.JoinRoom(msg.member, room);
                    } else {
                        await this.userSync.JoinRoom(msg.author, room, Boolean(msg.webhookID));
                    }
                    res = await trySend();
                    await afterSend(res);
                }
            });
            MetricPeg.get.requestOutcome(msg.id, true, "success");
        } catch (err) {
            MetricPeg.get.requestOutcome(msg.id, true, "fail");
            log.verbose("Failed to send message into room.", err);
        }
    }

    private async OnMessageUpdate(oldMsg: Discord.Message, newMsg: Discord.Message) {
        // Check if an edit was actually made
        if (oldMsg.content === newMsg.content) {
            return;
        }
        log.info(`Got edit event for ${newMsg.id}`);
        const storeEvent = await this.store.Get(DbEvent, {discord_id: oldMsg.id});
        if (storeEvent && storeEvent.Result) {
            while (storeEvent.Next()) {
                const matrixIds = storeEvent.MatrixId.split(";");
                await this.OnMessage(newMsg, matrixIds[0]);
                return;
            }
        }
        newMsg.content = `Edit: ${newMsg.content}`;
        await this.OnMessage(newMsg);
    }

    private async DeleteDiscordMessage(msg: Discord.Message) {
        log.info(`Got delete event for ${msg.id}`);
        const storeEvent = await this.store.Get(DbEvent, {discord_id: msg.id});
        if (!storeEvent || !storeEvent.Result) {
            log.warn(`Could not redact because the event was not in the store.`);
            return;
        }
        while (storeEvent.Next()) {
            log.info(`Deleting discord msg ${storeEvent.DiscordId}`);
            const intent = this.GetIntentFromDiscordMember(msg.author, msg.webhookID);
            await intent.ensureRegistered();
            this.userActivity.updateUserActivity(intent.userId);
            const matrixIds = storeEvent.MatrixId.split(";");
            try {
                await intent.underlyingClient.redactEvent(matrixIds[1], matrixIds[0]);
            } catch (ex) {
                log.warn(`Failed to delete ${storeEvent.DiscordId}, retrying as bot`);
                try {
                    await this.bridge.botIntent.underlyingClient.redactEvent(matrixIds[1], matrixIds[0]);
                } catch (ex) {
                    log.warn(`Failed to delete ${storeEvent.DiscordId}, giving up`);
                }
            }
        }
    }

    private async OnReactionAdd(
        reaction: Discord.MessageReaction,
        user: Discord.User | Discord.PartialUser,
    ) {
        if (user.id === this.GetBotId()) {
            return;
        }
        const discordMsgId = reaction.message.id;
        const storeEvent = await this.store.Get(DbEvent, { discord_id: discordMsgId });
        if (!storeEvent || !storeEvent.Result) {
            return;
        }

        let displayName = user.username || "";
        const guildId = reaction.message.guild?.id;
        const cachedMember = reaction.message.guild?.members?.resolve(user.id);
        if (cachedMember?.displayName) {
            displayName = cachedMember.displayName;
        } else {
            const resolved = await this.GetDiscordUserOrMember(user.id, guildId);
            if (resolved instanceof Discord.GuildMember) {
                displayName = resolved.displayName;
            } else if (resolved instanceof Discord.User) {
                displayName = resolved.username;
            }
        }
        if (!displayName) {
            displayName = user.id;
        }

        const emojiId = reaction.emoji.id;
        const emojiName = reaction.emoji.name || "emote";
        const emojiKey = emojiId ? `${emojiName}:${emojiId}` : emojiName;
        const emojiDisplay = emojiId ? `:${emojiName}:` : emojiName;
        let emojiMxc = "";
        if (emojiId) {
            try {
                emojiMxc = await this.GetEmoji(emojiName, Boolean(reaction.emoji.animated), emojiId);
            } catch (err) {
                log.warn(`Failed to upload custom reaction emoji ${emojiName} (${emojiId})`, err);
            }
        }

        while (storeEvent.Next()) {
            const [matrixMsgId, roomId] = storeEvent.MatrixId.split(";");
            const dbReaction = new DbReaction();
            dbReaction.DiscordMsgId = discordMsgId;
            dbReaction.RoomId = roomId;
            dbReaction.Source = "discord";
            dbReaction.UserId = user.id;
            dbReaction.DisplayName = displayName;
            dbReaction.EmojiKey = emojiKey;
            dbReaction.EmojiDisplay = emojiDisplay;
            dbReaction.EmojiMxc = emojiMxc;
            dbReaction.MatrixReactionEventId = "";
            await this.store.Insert(dbReaction);

            await this.UpdateMatrixReactionSummary(
                discordMsgId,
                matrixMsgId,
                roomId,
                storeEvent.ChannelId || reaction.message.channel.id,
                storeEvent.GuildId || guildId || "",
            );
        }
    }

    private async OnReactionRemove(
        reaction: Discord.MessageReaction,
        user: Discord.User | Discord.PartialUser,
    ) {
        if (user.id === this.GetBotId()) {
            return;
        }
        const discordMsgId = reaction.message.id;
        const storeEvent = await this.store.Get(DbEvent, { discord_id: discordMsgId });
        if (!storeEvent || !storeEvent.Result) {
            return;
        }
        const emojiId = reaction.emoji.id;
        const emojiName = reaction.emoji.name || "emote";
        const emojiKey = emojiId ? `${emojiName}:${emojiId}` : emojiName;

        while (storeEvent.Next()) {
            const [matrixMsgId, roomId] = storeEvent.MatrixId.split(";");
            const dbReaction = new DbReaction();
            dbReaction.DiscordMsgId = discordMsgId;
            dbReaction.RoomId = roomId;
            dbReaction.Source = "discord";
            dbReaction.UserId = user.id;
            dbReaction.EmojiKey = emojiKey;
            await this.store.Delete(dbReaction);

            await this.UpdateMatrixReactionSummary(
                discordMsgId,
                matrixMsgId,
                roomId,
                storeEvent.ChannelId || reaction.message.channel.id,
                storeEvent.GuildId || reaction.message.guild?.id || "",
            );
        }
    }

    private async OnReactionRemoveEmoji(reaction: Discord.MessageReaction) {
        const discordMsgId = reaction.message.id;
        const storeEvent = await this.store.Get(DbEvent, { discord_id: discordMsgId });
        if (!storeEvent || !storeEvent.Result) {
            return;
        }
        const emojiId = reaction.emoji.id;
        const emojiName = reaction.emoji.name || "emote";
        const emojiKey = emojiId ? `${emojiName}:${emojiId}` : emojiName;

        while (storeEvent.Next()) {
            const [matrixMsgId, roomId] = storeEvent.MatrixId.split(";");
            const dbReaction = new DbReaction();
            dbReaction.DiscordMsgId = discordMsgId;
            dbReaction.RoomId = roomId;
            dbReaction.Source = "discord";
            dbReaction.UserId = "";
            dbReaction.EmojiKey = emojiKey;
            await this.store.Delete(dbReaction);

            await this.UpdateMatrixReactionSummary(
                discordMsgId,
                matrixMsgId,
                roomId,
                storeEvent.ChannelId || reaction.message.channel.id,
                storeEvent.GuildId || reaction.message.guild?.id || "",
            );
        }
    }

    private async OnReactionRemoveAll(msg: Discord.Message | Discord.PartialMessage) {
        const discordMsgId = msg.id;
        const storeEvent = await this.store.Get(DbEvent, { discord_id: discordMsgId });
        if (!storeEvent || !storeEvent.Result) {
            return;
        }
        while (storeEvent.Next()) {
            const [matrixMsgId, roomId] = storeEvent.MatrixId.split(";");
            const dbReaction = new DbReaction();
            dbReaction.DiscordMsgId = discordMsgId;
            dbReaction.RoomId = roomId;
            dbReaction.Source = "discord";
            dbReaction.UserId = "";
            dbReaction.EmojiKey = "";
            await this.store.Delete(dbReaction);

            await this.UpdateMatrixReactionSummary(
                discordMsgId,
                matrixMsgId,
                roomId,
                storeEvent.ChannelId || msg.channel.id,
                storeEvent.GuildId || msg.guild?.id || "",
            );
        }
    }

    private async UpdateMatrixReactionSummary(
        discordMsgId: string,
        matrixMsgId: string,
        roomId: string,
        channelId: string,
        guildId: string,
    ) {
        const reactions = await this.store.Get(DbReaction, {
            discord_msg_id: discordMsgId,
            room_id: roomId,
            source: "discord",
        });
        const grouped = new Map<string, { display: string; mxc: string; users: string[] }>();
        if (reactions && reactions.Result) {
            while (reactions.Next()) {
                let entry = grouped.get(reactions.EmojiKey);
                if (!entry) {
                    entry = {
                        display: reactions.EmojiDisplay,
                        mxc: reactions.EmojiMxc,
                        users: [],
                    };
                    grouped.set(reactions.EmojiKey, entry);
                }
                if (!entry.users.includes(reactions.DisplayName)) {
                    entry.users.push(reactions.DisplayName);
                }
            }
        }

        const threadRow = await this.store.Get(DbReactionThread, {
            discord_msg_id: discordMsgId,
            room_id: roomId,
        });

        if (grouped.size === 0) {
            if (threadRow && threadRow.Result && threadRow.MatrixSummaryEventId) {
                try {
                    await this.bridge.botIntent.underlyingClient.redactEvent(roomId, threadRow.MatrixSummaryEventId);
                } catch (err) {
                    log.warn(`Failed to redact Matrix reaction summary ${threadRow.MatrixSummaryEventId}`, err);
                }
                threadRow.MatrixSummaryEventId = "";
                await this.store.Update(threadRow);
            }
            return;
        }

        const plainLines: string[] = [];
        const htmlLines: string[] = [];
        for (const entry of grouped.values()) {
            plainLines.push(`${entry.display}: ${entry.users.join(", ")}`);
            const emojiHtml = entry.mxc
                ? `<img data-mx-emoticon height="24" src="${escapeHtml(entry.mxc)}" alt="${escapeHtml(entry.display)}" title="${escapeHtml(entry.display)}" />`
                : escapeHtml(entry.display);
            htmlLines.push(`${emojiHtml}: ${entry.users.map((u) => escapeHtml(u)).join(", ")}`);
        }
        const body = plainLines.join("\n");
        const formattedBody = htmlLines.join("<br/>");

        if (threadRow && threadRow.Result && threadRow.MatrixSummaryEventId) {
            await this.bridge.botIntent.sendEvent(roomId, {
                body: `* ${body}`,
                format: "org.matrix.custom.html",
                formatted_body: `* ${formattedBody}`,
                "m.new_content": {
                    body,
                    format: "org.matrix.custom.html",
                    formatted_body: formattedBody,
                    msgtype: "m.notice",
                },
                "m.relates_to": {
                    event_id: threadRow.MatrixSummaryEventId,
                    rel_type: "m.replace",
                },
                msgtype: "m.notice",
            });
            return;
        }

        const summaryEventId = await this.bridge.botIntent.sendEvent(roomId, {
            body,
            format: "org.matrix.custom.html",
            formatted_body: formattedBody,
            "m.relates_to": {
                event_id: matrixMsgId,
                is_falling_back: true,
                "m.in_reply_to": {
                    event_id: matrixMsgId,
                },
                rel_type: "m.thread",
            },
            msgtype: "m.notice",
        });

        if (threadRow && threadRow.Result) {
            threadRow.MatrixSummaryEventId = summaryEventId;
            await this.store.Update(threadRow);
        } else {
            const newThread = new DbReactionThread();
            newThread.DiscordMsgId = discordMsgId;
            newThread.MatrixMsgId = matrixMsgId;
            newThread.RoomId = roomId;
            newThread.ChannelId = channelId;
            newThread.GuildId = guildId;
            newThread.MatrixSummaryEventId = summaryEventId;
            newThread.DiscordThreadId = "";
            newThread.DiscordSummaryMsgId = "";
            await this.store.Insert(newThread);
        }
    }

    private async UpdateDiscordReactionSummary(
        discordMsgId: string,
        matrixMsgId: string,
        roomId: string,
        channelId: string,
        guildId: string,
    ) {
        const reactions = await this.store.Get(DbReaction, {
            discord_msg_id: discordMsgId,
            room_id: roomId,
            source: "matrix",
        });
        const grouped = new Map<string, { display: string; users: string[] }>();
        if (reactions && reactions.Result) {
            while (reactions.Next()) {
                let entry = grouped.get(reactions.EmojiKey);
                if (!entry) {
                    entry = {
                        display: reactions.EmojiDisplay,
                        users: [],
                    };
                    grouped.set(reactions.EmojiKey, entry);
                }
                if (!entry.users.includes(reactions.DisplayName)) {
                    entry.users.push(reactions.DisplayName);
                }
            }
        }

        const threadRow = await this.store.Get(DbReactionThread, {
            discord_msg_id: discordMsgId,
            room_id: roomId,
        });
        const botToken = this.config.auth.botToken;

        if (grouped.size === 0) {
            if (threadRow && threadRow.Result && threadRow.DiscordThreadId) {
                try {
                    await Util.DiscordApiRequest("DELETE", `/channels/${threadRow.DiscordThreadId}`, botToken);
                } catch (err) {
                    log.warn(`Failed to delete Discord reaction thread ${threadRow.DiscordThreadId}`, err);
                }
                threadRow.DiscordThreadId = "";
                threadRow.DiscordSummaryMsgId = "";
                await this.store.Update(threadRow);
            }
            return;
        }

        const lines: string[] = [];
        for (const entry of grouped.values()) {
            lines.push(`${entry.display}: ${entry.users.join(", ")}`);
        }
        const summaryContent = lines.join("\n");

        if (threadRow && threadRow.Result && threadRow.DiscordThreadId && threadRow.DiscordSummaryMsgId) {
            try {
                // Unarchive briefly so the summary message can be edited
                await Util.DiscordApiRequest(
                    "PATCH",
                    `/channels/${threadRow.DiscordThreadId}`,
                    botToken,
                    { archived: false },
                );
                await Util.DiscordApiRequest(
                    "PATCH",
                    `/channels/${threadRow.DiscordThreadId}/messages/${threadRow.DiscordSummaryMsgId}`,
                    botToken,
                    {
                        allowed_mentions: { parse: [] },
                        content: summaryContent,
                    },
                );
                // Archive immediately so the thread is hidden from the channel sidebar
                await Util.DiscordApiRequest(
                    "PATCH",
                    `/channels/${threadRow.DiscordThreadId}`,
                    botToken,
                    {
                        archived: true,
                        auto_archive_duration: AUTO_ARCHIVE_MINUTES,
                    },
                );
                return;
            } catch (err) {
                log.warn(`Failed to update Discord reaction summary in thread ${threadRow.DiscordThreadId}`, err);
            }
        }

        try {
            let threadId = "";
            this.notifiedDiscordThreads.add(discordMsgId);
            try {
                const threadRes = await Util.DiscordApiRequest(
                    "POST",
                    `/channels/${channelId}/messages/${discordMsgId}/threads`,
                    botToken,
                    {
                        auto_archive_duration: AUTO_ARCHIVE_MINUTES,
                        name: "Reactions",
                    },
                );
                threadId = threadRes?.id || discordMsgId;
            } catch (err) {
                // If a thread was already created for this message, its ID is discordMsgId
                threadId = discordMsgId;
                await Util.DiscordApiRequest(
                    "PATCH",
                    `/channels/${threadId}`,
                    botToken,
                    { archived: false },
                );
            }
            this.notifiedDiscordThreads.add(threadId);

            const msgRes = await Util.DiscordApiRequest(
                "POST",
                `/channels/${threadId}/messages`,
                botToken,
                {
                    allowed_mentions: { parse: [] },
                    content: summaryContent,
                    flags: SUPPRESS_NOTIFICATIONS_FLAG,
                },
            );
            const summaryMsgId = msgRes?.id || "";
            if (summaryMsgId) {
                this.sentMessages.push(summaryMsgId);
            }

            // Immediately archive the thread so it does not clutter Discord's channel sidebar
            await Util.DiscordApiRequest(
                "PATCH",
                `/channels/${threadId}`,
                botToken,
                {
                    archived: true,
                    auto_archive_duration: AUTO_ARCHIVE_MINUTES,
                },
            );

            if (threadRow && threadRow.Result) {
                threadRow.DiscordThreadId = threadId;
                threadRow.DiscordSummaryMsgId = summaryMsgId;
                await this.store.Update(threadRow);
            } else {
                const newThread = new DbReactionThread();
                newThread.DiscordMsgId = discordMsgId;
                newThread.MatrixMsgId = matrixMsgId;
                newThread.RoomId = roomId;
                newThread.ChannelId = channelId;
                newThread.GuildId = guildId;
                newThread.MatrixSummaryEventId = "";
                newThread.DiscordThreadId = threadId;
                newThread.DiscordSummaryMsgId = summaryMsgId;
                await this.store.Insert(newThread);
            }
        } catch (err) {
            log.warn(`Failed to create Discord reaction thread on message ${discordMsgId}`, err);
        }
    }

    private async StoreMessagesSent(
        msg: Discord.Message | null | (Discord.Message | null)[],
        chan: Discord.TextChannel,
        event: IMatrixEvent,
    ) {
        if (!Array.isArray(msg)) {
            msg = [msg];
        }
        await Util.AsyncForEach(msg, async (m: Discord.Message) => {
            if (!m) {
                return;
            }
            log.verbose("Sent ", m.id);
            this.sentMessages.push(m.id);
            this.lastEventIds[chan.id] = m.id;
            try {
                const evt = new DbEvent();
                evt.MatrixId = `${event.event_id};${event.room_id}`;
                evt.DiscordId = m.id;
                evt.GuildId = chan.guild.id;
                evt.ChannelId = chan.id;
                await this.store.Insert(evt);
            } catch (err) {
                log.error(`Failed to insert sent event (${event.event_id};${event.room_id}) into store`, err);
            }
        });
    }

    private async onUserActivityChanged(state: UserActivityState) {
        for (const userId of state.changed) {
            const activity = state.dataSet.get(userId);
            if (activity) {
                await this.store.storeUserActivity(userId, activity);
            }
        }
        log.verbose(`Checking bridge limits (${state.activeUsers} active users)`);
        this.bridgeBlocker?.checkLimits(state.activeUsers).catch(err => {
            log.error(`Failed to check bridge limits: ${err}`);
        });;
        MetricPeg.get.setRemoteMonthlyActiveUsers(state.activeUsers);
    }
}

class AdminNotifier {
    constructor(
        private client:    MatrixClient,
        private adminMxid: string,
    ) {}

    public async notify(message: string) {
        const roomId = await this.ensureDMRoom(this.adminMxid);
        await this.client.sendText(roomId, message)
    }

    private async findDMRoom(targetMxid: string): Promise<string|undefined> {
        const rooms = await this.client.getJoinedRooms();
        const roomsWithMembers = await Promise.all(rooms.map(async (id) => {
            return {
                id,
                memberships: await this.client.getRoomMembers(id, undefined, ['join', 'invite']),
            }
        }));

        return roomsWithMembers.find(
            room => room.memberships.length == 2
                 && !!room.memberships.find(member => member.stateKey === targetMxid)
        )?.id;
    }

    private async ensureDMRoom(mxid: string): Promise<string> {
        const existing = await this.findDMRoom(mxid);
        if (existing) {
            log.verbose(`Found existing DM room with ${mxid}: ${existing}`);
            return existing;
        }

        const roomId = await this.client.createRoom();
        try {
            await this.client.inviteUser(mxid, roomId);
        } catch (err) {
            log.verbose(`Failed to invite ${mxid} to ${roomId}, cleaning up`);
            this.client.leaveRoom(roomId).catch(err => {
                log.error(`Failed to clean up to-be-DM room ${roomId}: ${err}`);
            });
            throw err;
        }

        log.verbose(`Created ${roomId} to DM with ${mxid}`);
        return roomId;
    }
}
