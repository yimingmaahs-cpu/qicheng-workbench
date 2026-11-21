const message = '请在“我的来源”导入群消息文本。';
function unavailable() { throw Object.assign(new Error(message), {status: 400}); }

export function textConnector() {
  return {
    mode: () => 'text',
    state: () => ({supported:false, connected:false, groups:[]}),
    status: () => ({installed:false, online:false}),
    check: () => ({ready:false, message}),
    progress: () => ({state:'idle'}),
    detect: unavailable, choose: unavailable, install: unavailable, groups: unavailable,
    bind: unavailable, read: unavailable, startSetup: unavailable, setup: unavailable,
    login: unavailable, stop() {}, close() {}
  };
}
