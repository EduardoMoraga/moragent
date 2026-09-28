#!/usr/bin/env node
import { runInline } from '../src/tui/inline/index.js';
import { FakeEngine } from '../test/fixtures/fake-engine.js';

const engine = new FakeEngine();
engine.startDemo();
await runInline({ engine });
