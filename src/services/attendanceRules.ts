/**
 * The rules that decide whether a punch is allowed, independent of Express and
 * the database so they can be exercised directly.
 *
 * These live on the server because that is the only place they mean anything.
 * The app also greys out the button, but a disabled button is a courtesy, not a
 * rule — anyone with the token can post to /auth/attendance/mark.
 */

/**
 * A check-out this soon after checking in is a mis-tap or a double capture, not
 * a shift. Sites that genuinely need shorter turnarounds should have this raised
 * deliberately rather than have every stray punch accepted.
 */
export const MIN_CHECKOUT_GAP_MINUTES = 30

export type AttendanceAction = 'check-in' | 'check-out'

/** The employee's most recent punch, or null if they have never punched. */
export type LastPunch = { action: string; createdAt: Date } | null

export type RuleVerdict =
    | { ok: true }
    | { ok: false; code: 'already-checked-in' | 'not-checked-in' | 'too-soon'; message: string; minutesRemaining?: number }

/** Whole minutes elapsed, rounded down — 29.9 minutes is not yet 30. */
function minutesBetween(from: Date, to: Date): number {
    return Math.floor((to.getTime() - from.getTime()) / 60_000)
}

/** When check-out becomes available for a check-in at `checkedInAt`. */
export function checkoutAvailableAt(checkedInAt: Date): Date {
    return new Date(checkedInAt.getTime() + MIN_CHECKOUT_GAP_MINUTES * 60_000)
}

/**
 * Evaluates an action against the employee's last punch.
 *
 * `now` is a parameter rather than read inside so the caller controls the clock
 * — the same instant is used for the verdict and for the row that follows.
 */
export function evaluateAction(action: AttendanceAction, last: LastPunch, now: Date): RuleVerdict {
    const isCheckedIn = last?.action === 'check-in'

    if (action === 'check-in') {
        if (isCheckedIn) {
            return {
                ok: false,
                code: 'already-checked-in',
                message: 'You are already checked in. Check out first.',
            }
        }
        return { ok: true }
    }

    // check-out
    if (!isCheckedIn) {
        return {
            ok: false,
            code: 'not-checked-in',
            message: 'You are not checked in, so there is nothing to check out of.',
        }
    }

    const elapsed = minutesBetween(last!.createdAt, now)
    if (elapsed < MIN_CHECKOUT_GAP_MINUTES) {
        // Round up what's left: with 29 whole minutes elapsed there is still part
        // of the 30th to wait, and "0 minutes left" while the button stays locked
        // is the more confusing answer.
        const minutesRemaining = Math.max(
            1,
            Math.ceil((checkoutAvailableAt(last!.createdAt).getTime() - now.getTime()) / 60_000)
        )
        return {
            ok: false,
            code: 'too-soon',
            message: `You checked in ${elapsed} minute${elapsed === 1 ? '' : 's'} ago. Check-out is available ${MIN_CHECKOUT_GAP_MINUTES} minutes after check-in — please try again in ${minutesRemaining} minute${minutesRemaining === 1 ? '' : 's'}.`,
            minutesRemaining,
        }
    }

    return { ok: true }
}
