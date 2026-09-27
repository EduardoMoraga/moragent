#!/usr/bin/env node
import { runTui } from '../src/tui/app.js';
import { FakeEngine } from '../test/fixtures/fake-engine.js';

const engine = new FakeEngine();
engine.startDemo();
await runTui({ engine });
