import { describe, expect, it, beforeEach } from 'vitest';
import { useUiStore } from './uiStore';

const initial = useUiStore.getState();

beforeEach(() => {
  useUiStore.setState(initial, true);
});

describe('uiStore', () => {
  it('defaults to seat 0, everything else off, verbosity at 2 ("rules")', () => {
    const s = useUiStore.getState();
    expect(s.viewingSeat).toBe(0);
    expect(s.revealAll).toBe(false);
    expect(s.overrideEnabled).toBe(false);
    expect(s.plainMode).toBe(false);
    expect(s.logVerbosity).toBe(2);
  });

  it('setViewingSeat only changes viewingSeat', () => {
    useUiStore.getState().setViewingSeat(1);
    expect(useUiStore.getState().viewingSeat).toBe(1);
    expect(useUiStore.getState().revealAll).toBe(false);
  });

  it('setRevealAll, setOverrideEnabled, setPlainMode toggle independently', () => {
    useUiStore.getState().setRevealAll(true);
    useUiStore.getState().setOverrideEnabled(true);
    useUiStore.getState().setPlainMode(true);
    const s = useUiStore.getState();
    expect(s.revealAll).toBe(true);
    expect(s.overrideEnabled).toBe(true);
    expect(s.plainMode).toBe(true);
    expect(s.viewingSeat).toBe(0); // untouched
  });

  it('setLogVerbosity only changes logVerbosity', () => {
    useUiStore.getState().setLogVerbosity(1);
    expect(useUiStore.getState().logVerbosity).toBe(1);
    expect(useUiStore.getState().viewingSeat).toBe(0);
  });
});
