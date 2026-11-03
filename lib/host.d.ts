export declare const MAX_DEPTH = 2;
export declare const MAX_SENDS_PER_HOUR = 20;
export declare const MAX_SENDS_TOTAL_PER_HOUR = 60;
export declare const MAX_OPENS_PER_HOUR = 10;
export declare const MAX_CANCELS_PER_HOUR = 10;
export declare const MAX_REPLY_STREAK = 8;
export declare const MAX_MESSAGE_BYTES: number;
export declare const WAIT_DEFAULT_S = 300;
export declare const WAIT_MAX_S = 1800;
export declare class MeshError extends Error {
    code: string;
    constructor(message: string, code: string);
}
export declare function parseMeshHeader(text: string | undefined): {
    from: string;
    depth: number;
    reply: boolean;
} | undefined;
/** Header of a genuine mesh relay: text header plus matching durable source. */
export declare function meshOf(event: any): {
    from: string;
    depth: number;
    reply: boolean;
} | undefined;
export declare function meshHeader(caller: string, cwd: unknown, depth: number, reply?: boolean): string;
/**
 * Mesh position of one session, derived from its log. `depth` is the
 * delegation depth that reached it since the user last typed in it (0 for a
 * session the user drives); replies never add depth. `peers` are sessions that
 * have messaged it, so a message back to one of them is a reply. `streak`
 * counts consecutive replies received from each peer.
 */
export declare function incomingMesh(events: any[]): {
    depth: number;
    peers: Set<string>;
    streak: Map<string, number>;
};
/** Sessions this session opened (from its own successful mesh_open results). */
export declare function openedSessions(events: any[]): Set<string>;
/**
 * Targets this session has successfully sent mesh messages to. Only calls with
 * a successful result count: a tool/call is logged before it executes, so an
 * in-flight call must not authorize itself.
 */
export declare function messagedSessions(events: any[]): Set<string>;
/** Count this session's own recent calls of one tool, optionally for one target. */
export declare function recentCalls(events: any[], toolName: string, now: number, target?: string): number;
/** Derive the waiting state of a session from its log and live agent. */
export declare function sessionState(events: any[], live?: any): {
    live: boolean;
    queued_messages: any;
    turn_open: boolean;
    last_turn_end_reason: string | null;
    running_tools: string[];
    waiting_for?: Record<string, unknown> | undefined;
    status: string;
};
/** Compact, model-facing feed items for one event, or undefined to skip it. */
export declare function feedItem(event: any, detailed?: boolean): Record<string, unknown> | undefined;
/** Whether the log has an unfinished mesh_wait tool call naming `sessionId`. */
export declare function waitingOn(events: any[], sessionId: string): boolean;
/** Text of the last assistant message of the last finished turn. */
export declare function lastAnswer(events: any[]): {
    seq: any;
    text: string;
} | undefined;
export declare function apply(ctx: any): void;
