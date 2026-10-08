import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHoverPopupController } from './hoverPopupController';

describe('createHoverPopupController', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const setup = () => {
        const open = vi.fn();
        const close = vi.fn();
        return { open, close, ctrl: createHoverPopupController({ open, close }) };
    };

    it('opens after the delay and skips a quick pass-through', () => {
        const { open, ctrl } = setup();
        ctrl.enter();
        ctrl.leave();
        vi.advanceTimersByTime(500);
        expect(open).not.toHaveBeenCalled();

        ctrl.enter();
        vi.advanceTimersByTime(150);
        expect(open).toHaveBeenCalledTimes(1);
    });

    it('stays open when the pointer moves onto the card within the grace delay', () => {
        const { close, ctrl } = setup();
        ctrl.enter();
        vi.advanceTimersByTime(150);
        ctrl.leave();
        ctrl.cancelClose();
        vi.advanceTimersByTime(500);
        expect(close).not.toHaveBeenCalled();

        ctrl.leave();
        vi.advanceTimersByTime(250);
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('keeps a pinned card open until reset', () => {
        const { close, ctrl } = setup();
        ctrl.pin();
        ctrl.leave();
        vi.advanceTimersByTime(500);
        expect(close).not.toHaveBeenCalled();
        expect(ctrl.isPinned()).toBe(true);

        ctrl.reset();
        expect(ctrl.isPinned()).toBe(false);
        ctrl.leave();
        vi.advanceTimersByTime(250);
        expect(close).toHaveBeenCalledTimes(1);
    });
});
