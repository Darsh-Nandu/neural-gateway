// User and auth

export interface  User {
    id: string;             // For uuid
    email: string;
    password_hash: string;
    role: 'free' | 'premium' | 'admin';
    created_at: Date;
    updated_at: Date;
}

export interface JwtPayload {
    sub: string;            // user id
    email: string;
    role: User['role'];
    iat?: number;           // isseued at
    exp?: number;           // expiration time
}

// Jobs

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface Job {
    id: string;
    user_id: string;
    session_id: string;
    status: JobStatus;
    prompt: string;
    result: string | null;
    error: string | null;
    priority: number;       // higher = processed sooner by BullMQ
    created_at: Date;
    updated_at: Date;
}

export interface LLMJobPayload {
    job_id: string;
    user_id: string;
    session_id: string;
    prompt: string;
    system_prompt?: string;
    context_docs?: string[]; // For rag chuncks
    priority: number;
}

// Usage / Billing

export interface Usage {
    id: string;
    user_id: string;
    job_id: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    created_at: Date;
} 

export const GROQ_PRICING: Record<string, {input: number, output: number}> = {
    'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
    'llama-3.1-8b-instant': { input: 0.05, output: 0.08 },
    'mixtral-8x7b-32768': {input: 0.24, output: 0.24 }
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
    const pricing = GROQ_PRICING[model] ?? { input: 0.59, output: 0.79 };
    return (
        (inputTokens / 1_000_000) * pricing.input +
        (outputTokens / 1_000_000) * pricing.output
    );
}

// Memory System

export interface SessionMessage {
    id: string;
    session_id: string;
    user_id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    created_at: Date;
}

export interface Session {
    id: string;
    user_id: string;
    title: string | null;   // Auto generated from first message
    created_at: Date;
    updated_at: Date;
    last_message_at: Date | null;
}

export interface UserMemory {
    id: string;
    user_id: string;
    key: string;
    value: string;
    confidence: number;         // 0.0 - 1.0
    source_session_id: string;  // which session this was extracted from
    created_at: Date;
    updated_at: Date;
}

export interface DocumentChunk {
    id: string;
    user_id: string;
    document_id: string;
    content: string;
    chunk_index: number;
    /**
    *  768-dimensional vector from Gemini text-embedding-004 
    */
    embedding?: number[];
    metadata: {
        filename: string;
        total_chunks: number;
    };
}

export interface RetrievalResult {
    chunk: DocumentChunk;
    /**
    * Cosine similarity score: 0.0 (completely unrelated) → 1.0 (identical).
    * We typically filter out results below 0.70.
    */
    score: number;
}

/** 
* Request body sent to the embedding service.
* The service calls Gemini text-embedding-004 and stores in Qdrant.
*/
export interface EmbedRequest {
    chunks: Array<{
        content: string;
        document_id: string;
        chunk_index: number;
        metadata: DocumentChunk['metadata'];
    }>;
    user_id: string;
}

// SSE 

/**
 * Every SSE message sent to the client has this shape.
 *
 * Event flow:
 *   status("processing") → token("Hello") → token(" world") → ... → done("full text")
 *   or on failure:
 *   status("processing") → error("Rate limit exceeded")
 */

export interface SSEEvent {
    type: 'token' | 'done' | 'error' | 'status';
    data: string;
    job_id?: string;
}