import type { Rule } from '../types.js';
import { loopDetect } from './loop-detect.js';
import { reread } from './reread.js';
import { contextPressure } from './context-pressure.js';
import { claudeMd } from './claude-md.js';
import { mcpOpportunity } from './mcp-opportunity.js';
import { deadWeight } from './dead-weight.js';
import { mcpErrors } from './mcp-errors.js';
import { permissionFriction } from './permission-friction.js';
import { burnRate } from './burn-rate.js';
import { taskQuality } from './task-quality.js';
import { historyLesson } from './history-lesson.js';
import { verificationConsent } from './verification-consent.js';

export const RULES: Rule[] = [loopDetect, reread, contextPressure, claudeMd, mcpOpportunity, deadWeight, mcpErrors, permissionFriction, burnRate, taskQuality, historyLesson, verificationConsent];

export { loopDetect, reread, contextPressure, claudeMd, mcpOpportunity, deadWeight, mcpErrors, permissionFriction, burnRate, taskQuality, historyLesson, verificationConsent };
