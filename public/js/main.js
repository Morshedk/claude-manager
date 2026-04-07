import { render, h } from 'preact';
import { App } from './components/App.js';
import { connect } from './ws/connection.js';
import { initMessageHandlers } from './state/sessionState.js';

// Start WebSocket connection (auto-reconnects on close)
connect();

// Wire up all global WS message handlers to state signals
initMessageHandlers();

// Mount the Preact app
render(h(App, null), document.getElementById('app'));
