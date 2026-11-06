/*
Copyright 2026 matrix-appservice-discord

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

import { DiscordStore } from "../store";
import { IDbData, IDbDataMany } from "./dbdatainterface";
import { ISqlCommandParameters } from "./connector";

export class DbReactionThread implements IDbData {
    public DiscordMsgId: string;
    public MatrixMsgId: string;
    public RoomId: string;
    public ChannelId: string;
    public GuildId: string;
    public MatrixSummaryEventId: string;
    public DiscordThreadId: string;
    public DiscordSummaryMsgId: string;
    public Result: boolean;

    public async RunQuery(store: DiscordStore, params: ISqlCommandParameters): Promise<void> {
        const row = await store.db.Get(
            `SELECT * FROM reaction_threads WHERE discord_msg_id = $discord_msg_id AND room_id = $room_id`,
            {
                /* eslint-disable @typescript-eslint/naming-convention */
                discord_msg_id: params.discord_msg_id,
                room_id: params.room_id,
                /* eslint-enable @typescript-eslint/naming-convention */
            },
        );
        this.Result = Boolean(row);
        if (this.Result && row) {
            this.DiscordMsgId = row.discord_msg_id as string;
            this.MatrixMsgId = row.matrix_msg_id as string;
            this.RoomId = row.room_id as string;
            this.ChannelId = row.channel_id as string;
            this.GuildId = row.guild_id as string;
            this.MatrixSummaryEventId = (row.matrix_summary_event_id as string) || "";
            this.DiscordThreadId = (row.discord_thread_id as string) || "";
            this.DiscordSummaryMsgId = (row.discord_summary_msg_id as string) || "";
        }
    }

    public async Insert(store: DiscordStore): Promise<void> {
        await store.db.Run(
            `INSERT INTO reaction_threads (
                discord_msg_id,
                matrix_msg_id,
                room_id,
                channel_id,
                guild_id,
                matrix_summary_event_id,
                discord_thread_id,
                discord_summary_msg_id
            ) VALUES (
                $discord_msg_id,
                $matrix_msg_id,
                $room_id,
                $channel_id,
                $guild_id,
                $matrix_summary_event_id,
                $discord_thread_id,
                $discord_summary_msg_id
            );`,
            {
                /* eslint-disable @typescript-eslint/naming-convention */
                channel_id: this.ChannelId,
                discord_msg_id: this.DiscordMsgId,
                discord_summary_msg_id: this.DiscordSummaryMsgId || null,
                discord_thread_id: this.DiscordThreadId || null,
                guild_id: this.GuildId,
                matrix_msg_id: this.MatrixMsgId,
                matrix_summary_event_id: this.MatrixSummaryEventId || null,
                room_id: this.RoomId,
                /* eslint-enable @typescript-eslint/naming-convention */
            },
        );
    }

    public async Update(store: DiscordStore): Promise<void> {
        await store.db.Run(
            `UPDATE reaction_threads
            SET matrix_summary_event_id = $matrix_summary_event_id,
                discord_thread_id = $discord_thread_id,
                discord_summary_msg_id = $discord_summary_msg_id
            WHERE discord_msg_id = $discord_msg_id AND room_id = $room_id;`,
            {
                /* eslint-disable @typescript-eslint/naming-convention */
                discord_msg_id: this.DiscordMsgId,
                discord_summary_msg_id: this.DiscordSummaryMsgId || null,
                discord_thread_id: this.DiscordThreadId || null,
                matrix_summary_event_id: this.MatrixSummaryEventId || null,
                room_id: this.RoomId,
                /* eslint-enable @typescript-eslint/naming-convention */
            },
        );
    }

    public async Delete(store: DiscordStore): Promise<void> {
        await store.db.Run(
            `DELETE FROM reaction_threads WHERE discord_msg_id = $discord_msg_id AND room_id = $room_id;`,
            {
                /* eslint-disable @typescript-eslint/naming-convention */
                discord_msg_id: this.DiscordMsgId,
                room_id: this.RoomId,
                /* eslint-enable @typescript-eslint/naming-convention */
            },
        );
    }
}

export class DbReaction implements IDbDataMany {
    public DiscordMsgId: string;
    public RoomId: string;
    public Source: string;
    public UserId: string;
    public DisplayName: string;
    public EmojiKey: string;
    public EmojiDisplay: string;
    public EmojiMxc: string;
    public MatrixReactionEventId: string;
    public Result: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private rows: any[] = [];

    get ResultCount(): number {
        return this.rows.length;
    }

    public async RunQuery(store: DiscordStore, params: ISqlCommandParameters): Promise<void> {
        this.rows = [];
        if (params.matrix_reaction_event_id && params.room_id) {
            this.rows = await store.db.All(
                `SELECT * FROM reactions
                WHERE matrix_reaction_event_id = $matrix_reaction_event_id
                AND room_id = $room_id;`,
                {
                    /* eslint-disable @typescript-eslint/naming-convention */
                    matrix_reaction_event_id: params.matrix_reaction_event_id,
                    room_id: params.room_id,
                    /* eslint-enable @typescript-eslint/naming-convention */
                },
            );
        } else if (params.discord_msg_id && params.room_id && params.source) {
            this.rows = await store.db.All(
                `SELECT * FROM reactions
                WHERE discord_msg_id = $discord_msg_id
                AND room_id = $room_id
                AND source = $source;`,
                {
                    /* eslint-disable @typescript-eslint/naming-convention */
                    discord_msg_id: params.discord_msg_id,
                    room_id: params.room_id,
                    source: params.source,
                    /* eslint-enable @typescript-eslint/naming-convention */
                },
            );
        } else if (params.discord_msg_id && params.source) {
            this.rows = await store.db.All(
                `SELECT * FROM reactions
                WHERE discord_msg_id = $discord_msg_id
                AND source = $source;`,
                {
                    /* eslint-disable @typescript-eslint/naming-convention */
                    discord_msg_id: params.discord_msg_id,
                    source: params.source,
                    /* eslint-enable @typescript-eslint/naming-convention */
                },
            );
        } else {
            throw new Error("Unknown/incorrect params given to DbReaction.RunQuery");
        }
        this.Result = this.rows.length !== 0;
    }

    public Next(): boolean {
        if (!this.Result || this.ResultCount === 0) {
            return false;
        }
        const item = this.rows.shift();
        this.DiscordMsgId = item.discord_msg_id as string;
        this.RoomId = item.room_id as string;
        this.Source = item.source as string;
        this.UserId = item.user_id as string;
        this.DisplayName = item.display_name as string;
        this.EmojiKey = item.emoji_key as string;
        this.EmojiDisplay = item.emoji_display as string;
        this.EmojiMxc = (item.emoji_mxc as string) || "";
        this.MatrixReactionEventId = (item.matrix_reaction_event_id as string) || "";
        return true;
    }

    public async Insert(store: DiscordStore): Promise<void> {
        await store.db.Run(
            `DELETE FROM reactions
            WHERE discord_msg_id = $discord_msg_id
            AND room_id = $room_id
            AND source = $source
            AND user_id = $user_id
            AND emoji_key = $emoji_key;`,
            {
                /* eslint-disable @typescript-eslint/naming-convention */
                discord_msg_id: this.DiscordMsgId,
                emoji_key: this.EmojiKey,
                room_id: this.RoomId,
                source: this.Source,
                user_id: this.UserId,
                /* eslint-enable @typescript-eslint/naming-convention */
            },
        );
        await store.db.Run(
            `INSERT INTO reactions (
                discord_msg_id,
                room_id,
                source,
                user_id,
                display_name,
                emoji_key,
                emoji_display,
                emoji_mxc,
                matrix_reaction_event_id
            ) VALUES (
                $discord_msg_id,
                $room_id,
                $source,
                $user_id,
                $display_name,
                $emoji_key,
                $emoji_display,
                $emoji_mxc,
                $matrix_reaction_event_id
            );`,
            {
                /* eslint-disable @typescript-eslint/naming-convention */
                discord_msg_id: this.DiscordMsgId,
                display_name: this.DisplayName,
                emoji_display: this.EmojiDisplay,
                emoji_key: this.EmojiKey,
                emoji_mxc: this.EmojiMxc || null,
                matrix_reaction_event_id: this.MatrixReactionEventId || null,
                room_id: this.RoomId,
                source: this.Source,
                user_id: this.UserId,
                /* eslint-enable @typescript-eslint/naming-convention */
            },
        );
    }

    public async Update(store: DiscordStore): Promise<void> {
        throw new Error("Update is not implemented on DbReaction");
    }

    public async Delete(store: DiscordStore): Promise<void> {
        if (this.UserId && this.EmojiKey) {
            await store.db.Run(
                `DELETE FROM reactions
                WHERE discord_msg_id = $discord_msg_id
                AND room_id = $room_id
                AND source = $source
                AND user_id = $user_id
                AND emoji_key = $emoji_key;`,
                {
                    /* eslint-disable @typescript-eslint/naming-convention */
                    discord_msg_id: this.DiscordMsgId,
                    emoji_key: this.EmojiKey,
                    room_id: this.RoomId,
                    source: this.Source,
                    user_id: this.UserId,
                    /* eslint-enable @typescript-eslint/naming-convention */
                },
            );
        } else if (this.EmojiKey) {
            await store.db.Run(
                `DELETE FROM reactions
                WHERE discord_msg_id = $discord_msg_id
                AND room_id = $room_id
                AND source = $source
                AND emoji_key = $emoji_key;`,
                {
                    /* eslint-disable @typescript-eslint/naming-convention */
                    discord_msg_id: this.DiscordMsgId,
                    emoji_key: this.EmojiKey,
                    room_id: this.RoomId,
                    source: this.Source,
                    /* eslint-enable @typescript-eslint/naming-convention */
                },
            );
        } else {
            await store.db.Run(
                `DELETE FROM reactions
                WHERE discord_msg_id = $discord_msg_id
                AND room_id = $room_id
                AND source = $source;`,
                {
                    /* eslint-disable @typescript-eslint/naming-convention */
                    discord_msg_id: this.DiscordMsgId,
                    room_id: this.RoomId,
                    source: this.Source,
                    /* eslint-enable @typescript-eslint/naming-convention */
                },
            );
        }
    }
}
