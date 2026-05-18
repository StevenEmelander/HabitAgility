/**
 * Shared JSDoc @typedefs for the front-end. Pure documentation — no runtime code.
 * Imported as a side-effect in modules that want IDE autocomplete on these shapes.
 *
 * Mirrors the wire format produced by the lambda; if the server contract changes,
 * update both this file and the lambda's `sprintItemToObject` / `entryItemToObject`.
 */

/**
 * @typedef {('boolean'|'count')} HabitKind
 */

/**
 * @typedef BooleanHabitScoring
 * @property {number} points  Points awarded when toggled on.
 */

/**
 * @typedef CountHabitScoring
 * @property {number} pointsPerUnit  Points per single unit.
 * @property {number} dailyLimit     Upper cap on units per day; 0 = unlimited.
 */

/**
 * @typedef Habit
 * @property {string}                 id
 * @property {string}                 categoryId
 * @property {string}                 label
 * @property {HabitKind}              kind
 * @property {BooleanHabitScoring|CountHabitScoring} scoring
 */

/**
 * @typedef Category
 * @property {string} id
 * @property {string} label
 * @property {number} sortOrder
 * @property {string} accent  CSS color string.
 */

/**
 * @typedef Sprint
 * @property {number}     id           Positive integer; assigned by server on creation.
 * @property {string}     startDate    YYYY-MM-DD.
 * @property {string}     endDate      YYYY-MM-DD.
 * @property {number}     lengthDays
 * @property {number}     [pointStep]  One of 0.1 / 0.25 / 0.5 / 1; default 1.
 * @property {number}     goalPoints   Daily goal points; default 10 if missing.
 * @property {Category[]} categories
 * @property {Habit[]}    habitDefinitions
 */

/**
 * @typedef Entry
 * @property {string}                  dateKey
 * @property {Object<string, boolean|number>} habitValuesById  habitId → value
 * @property {number|null}             sprintId   The sprint covering this date.
 */

/**
 * @typedef SprintSummary
 * @property {number} sprintId
 * @property {string} startDate
 * @property {string} endDate
 * @property {number} pts        Sum of earned points across the sprint's days.
 * @property {number} days       Number of days in [startDate, min(endDate,today)] inclusive.
 * @property {number} goalPoints Daily goal at the time of computation.
 * @property {number} goalTotal  goalPoints × days.
 */

/**
 * @typedef DayBucket
 * @property {string} key   dateKey for daily buckets.
 * @property {number} pts   Earned points.
 * @property {number} goal  Daily goal points.
 * @property {number} days  Always 1 for daily buckets.
 */

// No exports — this file is purely for @typedef discovery by IDEs / type-checkers.
export {};
