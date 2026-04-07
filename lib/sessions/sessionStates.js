export const STATES = {
  CREATED: 'created',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  STOPPED: 'stopped',
  ERROR: 'error',
};

export const TRANSITIONS = {
  [STATES.CREATED]:  [STATES.STARTING],
  [STATES.STARTING]: [STATES.RUNNING, STATES.ERROR, STATES.STOPPED],
  [STATES.RUNNING]:  [STATES.STOPPING, STATES.ERROR, STATES.STOPPED],
  [STATES.STOPPING]: [STATES.STOPPED, STATES.ERROR],
  [STATES.STOPPED]:  [STATES.STARTING],
  [STATES.ERROR]:    [STATES.STARTING],
};

/**
 * Assert that a state transition from → to is valid.
 * Throws if the transition is not allowed.
 * @param {string} from
 * @param {string} to
 */
export function assertTransition(from, to) {
  const allowed = TRANSITIONS[from];
  if (!allowed) {
    throw new Error(`Unknown state: "${from}"`);
  }
  if (!allowed.includes(to)) {
    throw new Error(
      `Invalid state transition: ${from} → ${to}. Allowed: ${allowed.join(', ')}`
    );
  }
}

/**
 * Returns true if the state is a terminal (end) state.
 * @param {string} state
 * @returns {boolean}
 */
export function isTerminal(state) {
  return state === STATES.STOPPED || state === STATES.ERROR;
}
