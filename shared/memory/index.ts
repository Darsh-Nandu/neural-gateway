/**
 * @fileoverview Memory system for NeuralGateway.
 *
 * TWO TYPES OF MEMORY:
 *
 * 1. SESSION MEMORY (short-term)
 *    Stores every message in the current chat thread in PostgreSQL.
 *    When building a new LLM request, we load the last N messages and
 *    pass them as the conversation history array to Groq.
 *
 * 2. GENERAL MEMORY (long-term, cross-session)
 *    After every N messages, we ask Groq to extract key facts about the
 *    user (name, expertise, preferences). These are stored in `user_memory`
 *    and injected into the system prompt of EVERY future session - so the
 *    AI remembers who you are even in brand new conversations.
 *
 * LLM USED HERE: Groq (llama-3.3-70b-versatile)
 * EMBEDDINGS: NOT handled here - see services/embedding (Gemini)
 */

import Groq from "groq-sdk";
import { query, transaction } from "../db/index.js";
import type {
    SessionMessage,
    Session,
    UserMemory,
} from "../types/index.js";

let groqClient: Groq | null = null;

function getGroq(): Groq {
    if (!groqClient) {
            groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY});
    }
    return groqClient;
}

const GORQ_MODEL = process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';

// Session management

export async function createSession(userId: string): Promise<Session> {
    const rows = await query<Session>(
        `INSERT INTO sessions (user_id) VALUES ($1) RETURNING *`,
        [userId]
    );
    return rows[0];
}

/**
 * Fetches all sessions for a user, sorted by most recent activity.
 * Used to render the sidebar list of past conversations.
 */

export async function getUserSessions(userId: string): Promise<Session[]> {
    return query<Session>(
        `SELECT * FROM sessions
        WHERE user_id = $1
        ORDER BY COALESCE(last_message_at, created_at) DESC`,
        [userId]
    );
}

/**
 * Adds a single message to a session and bumps the session's last_message_at.
 * Wrapped in a transaction so both writes succeed or both roll back.
 */

export async function addMessage(
    sessionId: string,
    userId: string,
    role: SessionMessage['role'],
    content: string
): Promise<SessionMessage> {
    return transaction(async (client) => {
        const result = await client.query<SessionMessage>(
            `INSERT INTO session_messages (session_id, user_id, role, content)
            VALUES ($1, $2, $3, $4)
            RETURNING *`,
            [sessionId, userId, role, client]
        );
        await client.query(
            `UPDATE sessions SET last_messages_at = now() WHERE id = $1`,
            [sessionId]
        );
        return result.rows[0];
    });
}

export async function getSessionHistory(
    sessionId: string,
    windowSize: number = parseInt(process.env.SESSION_MEMORY_WINDOW ?? '20' , 10)
): Promise<SessionMessage[]> {
    return query<SessionMessage>(
        `SELECT * FROM (
            SELECT * FROM session_messages
            WHERE session_id = $1
            ORDER BY created_at DESC
            LIMIT $2
        ) sub 
        ORDER BY created_at ASC`,
        [sessionId, windowSize]
    );
}

/**
 * Converts our DB SessionMessage rows into the format Groq (OpenAI-compatible)
 * expects: an array of { role, content } objects.
 *
 * We filter out 'system' role messages — those go in the separate `system` param.
 */

export function formatMessagesForAPI(messages: SessionMessage[]): Array<{role: 'user' | 'assistant'; content: string}> {
    return messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: m.content
        }));
}

// General memory (long-term, cross-session)

/**
 * Retrieves all stored memory facts for a user from the DB.
 */
export async function getUserMemory(userId: string): Promise<UserMemory[]> {
    return query<UserMemory>(
        `SELECT * FROM user_memory WHERE user_id = $1 ORDER BY key ASC`,
        [userId]
    );
}

export function formatMemoryForSystemPrompt(memories: UserMemory[]): string {
    const highConfidence = memories.filter((m) => m.confidence >= 0.7);
    if (highConfidence.length === 0) return '';

    const facts = highConfidence
        .map((m) => ` - ${m.key}: ${m.value}`)
        .join('\n');

    return (
        `Here is what you know about this user from previous conversations:\n${facts}\n\n` +
        `Use this to personalise your responses naturally. ` +
        `Do NOT explicitly say "I know you prefer X" — just apply it silently.`
    );
}

export async function extractAndStoreMemory(userId:string, sessionId: string, messages: SessionMessage[]): Promise<void> {
    
}