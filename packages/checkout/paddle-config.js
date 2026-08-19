/**
 * Client-side token de Paddle — NO es secreto (está diseñado para ir en
 * el cliente, como la apiKey de Firebase). La API Key real de Paddle
 * nunca va acá, esa vive en Secret Manager (ver
 * firebase/functions/src/payments).
 */
export const PADDLE_CLIENT_TOKEN = 'TODO_REEMPLAZAR';
export const PADDLE_ENVIRONMENT = 'sandbox'; // 'sandbox' | 'production'
