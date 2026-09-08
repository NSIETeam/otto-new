/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { Type, type FunctionDeclaration } from '@google/genai';
export const CLAIM_REVIEW_TOOL_NAME = 'review_answer_evidence';
const str = { type: Type.STRING };
export const CLAIM_REVIEW_DECLARATION: FunctionDeclaration = {
  name: CLAIM_REVIEW_TOOL_NAME,
  description:
    'Review researched claims against native receipts from web_fetch evidence_only=true. Bind sourceId=call ID+:0 and UTF-16 start/end. Cover the draft; final text must equal it. quotation uses exact words linked to that quotation’s source; no fixed prefix. Citation labels must be neutral or excerpted from their linked evidence. inference uses evidence links and natural uncertainty (可能/may). Numerical inference requires facet subject/metric/period/unit plus each anchor’s signed value in one unambiguous passage; retain the original numeric clause before the inference. Translations, conversions and new calculations are not independently verified here. uncertain naturally explains missing evidence or conflicts; link both sides of conflicts. Requested periods can be covered across claims. One shared recency/publisher caveat suffices: retrieval time proves neither. Checks attribution/coverage, not truth. Skip ordinary answers without researched claims. Source failures or source/draft/request changes invalidate review. No execution or permission grant.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      requestRevision: { type: Type.INTEGER },
      draft: str,
      claims: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            text: str,
            kind: {
              type: Type.STRING,
              enum: ['quotation', 'inference', 'uncertain'],
            },
            facet: {
              type: Type.OBJECT,
              properties: { subject: str, metric: str, period: str, unit: str },
              required: ['subject', 'metric', 'period', 'unit'],
            },
            evidence: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  sourceId: str,
                  start: { type: Type.INTEGER },
                  end: { type: Type.INTEGER },
                  value: str,
                },
                required: ['sourceId', 'start', 'end'],
              },
            },
          },
          required: ['text', 'kind', 'evidence'],
        },
      },
    },
    required: ['requestRevision', 'draft', 'claims'],
  },
};
