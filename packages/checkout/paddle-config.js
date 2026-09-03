/**
 * Client-side token de Paddle — NO es secreto (está diseñado para ir en
 * el cliente, como la apiKey de Firebase). La API Key real de Paddle
 * nunca va acá, esa vive en Secret Manager (ver
 * firebase/functions/src/payments).
 */
export const PADDLE_CLIENT_TOKEN = 'test_cf52422f9608e37572fa46afa69';
export const PADDLE_ENVIRONMENT = 'sandbox'; // 'sandbox' | 'production'
