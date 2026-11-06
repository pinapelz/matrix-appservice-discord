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

import { IDbSchema } from "./dbschema";
import { DiscordStore } from "../../store";
import { Log } from "../../log";

const log = new Log("SchemaV13");

export class Schema implements IDbSchema {
    public description = "create reaction_threads and reactions tables";

    public async run(store: DiscordStore): Promise<void> {
        try {
            await store.createTable(
                `CREATE TABLE reaction_threads (
                    discord_msg_id TEXT NOT NULL,
                    matrix_msg_id TEXT NOT NULL,
                    room_id TEXT NOT NULL,
                    channel_id TEXT NOT NULL,
                    guild_id TEXT NOT NULL,
                    matrix_summary_event_id TEXT,
                    discord_thread_id TEXT,
                    discord_summary_msg_id TEXT,
                    PRIMARY KEY (discord_msg_id, room_id)
                );`,
                "reaction_threads",
            );
            await store.createTable(
                `CREATE TABLE reactions (
                    discord_msg_id TEXT NOT NULL,
                    room_id TEXT NOT NULL,
                    source TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    emoji_key TEXT NOT NULL,
                    emoji_display TEXT NOT NULL,
                    emoji_mxc TEXT,
                    matrix_reaction_event_id TEXT,
                    PRIMARY KEY (discord_msg_id, room_id, source, user_id, emoji_key)
                );`,
                "reactions",
            );
        } catch (ex) {
            log.error("Failed to create reaction tables:", ex);
        }
    }

    public async rollBack(store: DiscordStore): Promise<void> {
        await store.db.Exec("DROP TABLE IF EXISTS reactions;");
        await store.db.Exec("DROP TABLE IF EXISTS reaction_threads;");
    }
}
