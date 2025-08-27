// ui-state.js — ES Module

export const ui = {
    status: 'idle', // idle | joining | joined | leaving
    roomId: 'NULL',
    userId: 'NULL',
    localgroups: [],
    groups: new Map(), // groupId -> GroupState
};

export class GroupState {
    /**
     * @param {int} groupId
     * @param {'local'|'remote'} mode
     * @param {string} userIdFromCreator
     * @param {string} videoId producerId or consumerId or "NULL"
     * @param {string} audioId producerId or consumerId or "NULL"
     * @param {HTMLElement} card
     */
    constructor(groupId, mode, userIdFromCreator, videoId, audioId, card) {
        this.groupId = groupId;
        this.mode = mode;
        this.userIdFromCreator = userIdFromCreator;
        this.videoId = videoId;
        this.audioId = audioId;
        this.card = card;
        // per-kind media info kept by UI (stream, role, id, paused, synthetic)
        this.media = {
            video: { stream: null, role: 'none', id: 'NULL', paused: false, synthetic: false },
            audio: { stream: null, role: 'none', id: 'NULL', paused: false, synthetic: false },
        };
    }
}
