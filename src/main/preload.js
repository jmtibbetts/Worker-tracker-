'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = new Set([
  'state:get', 'report:get',
  'timer:start', 'timer:stop', 'timer:idleDecision',
  'entry:addManual', 'entry:update', 'entry:delete',
  'project:save', 'project:setArchived',
  'settings:save',
  'export:csv', 'export:backup',
  'invoice:create', 'invoice:pdf', 'invoice:setPaid', 'invoice:delete',
  'screenshot:delete',
  'permissions:get', 'permissions:open',
  'data:openFolder',
]);
const EVENTS = new Set(['tick', 'changed', 'idle-return', 'auto-stopped']);

contextBridge.exposeInMainWorld('api', {
  invoke(channel, payload) {
    if (!INVOKE_CHANNELS.has(channel)) throw new Error(`Unknown channel: ${channel}`);
    return ipcRenderer.invoke(channel, payload);
  },
  on(event, handler) {
    if (!EVENTS.has(event)) throw new Error(`Unknown event: ${event}`);
    ipcRenderer.on(event, (_e, payload) => handler(payload));
  },
  platform: process.platform,
});
