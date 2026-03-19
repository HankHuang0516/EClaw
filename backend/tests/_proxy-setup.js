/**
 * Proxy setup for running integration tests in environments with HTTP_PROXY.
 * Usage: node --require ./tests/_proxy-setup.js tests/test-xxx.js
 */
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
  try {
    const { ProxyAgent, setGlobalDispatcher } = require('undici');
    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
  } catch (e) {
    // undici not installed, skip proxy setup
  }
}
