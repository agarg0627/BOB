// Owned by Person C. Locked contract — do not modify without team agreement.

export interface Feature {
  id: string;
  name: string;
  userPrompt: string;
  urlPattern: string;
  code: string;
  description: string;
  enabled: boolean;
  createdAt: number;
}

export interface GenerateRequest {
  prompt: string;
  url: string;
  domSnapshot?: string;
  existingCode?: string;
}

export interface GenerateResponse {
  code: string;
  name: string;
  description: string;
  urlPattern: string;
}

export type Message =
  | { type: 'GENERATE_FEATURE'; req: GenerateRequest }
  | { type: 'INSTALL_FEATURE'; feature: Omit<Feature, 'id' | 'createdAt'> }
  | { type: 'GET_FEATURES_FOR_URL'; url: string }
  | { type: 'LIST_FEATURES' }
  | { type: 'DELETE_FEATURE'; id: string }
  | { type: 'TOGGLE_FEATURE'; id: string; enabled: boolean };
