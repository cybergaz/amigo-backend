import { Elysia } from "elysia";
import { convertBigIntToString } from "@/utils/serialization.utils";

/**
 * Elysia plugin that automatically converts all BigInt values to strings
 * in response bodies before serialization.
 * 
 * This prevents JSON.stringify errors when BigInt values are present in responses.
 * 
 * Usage:
 * ```ts
 * const app = new Elysia()
 *   .use(bigintSerializationPlugin)
 *   // ... rest of your routes
 * ```
 */
export const bigintSerializationPlugin = new Elysia({ name: "bigint-serialization" })
  .onAfterHandle(({ responseValue }) => {
    // In Elysia, onAfterHandle receives { responseValue } where responseValue is the handler's return value
    // Only transform if responseValue is an object/array (not already a string or Response object)
    if (responseValue && typeof responseValue === 'object' && !(responseValue instanceof Response) && !(responseValue instanceof Date)) {
      try {
        // Convert all BigInt values to strings recursively
        const transformed = convertBigIntToString(responseValue);
        
        // Verify the transformation worked by attempting to stringify
        // This will throw if there are still BigInt values or circular references
        const testString = JSON.stringify(transformed);
        
        // Debug: Log if transformation happened (only for conversation history to avoid spam)
        if (transformed?.data?.messages) {
          console.log('[BIGINT-SERIALIZATION] Transformed response, message count:', transformed.data.messages.length);
        }
        
        // Return the transformed response
        return transformed;
      } catch (error) {
        console.error('[BIGINT-SERIALIZATION] Error transforming response:', error);
        console.error('[BIGINT-SERIALIZATION] ResponseValue type:', typeof responseValue);
        console.error('[BIGINT-SERIALIZATION] ResponseValue keys:', responseValue && typeof responseValue === 'object' ? Object.keys(responseValue) : 'N/A');
        
        // If transformation fails, try to return original (might still fail, but at least we log the error)
        // This will likely cause a 500 error, but at least we'll know what went wrong
        return responseValue;
      }
    }
    
    // Return responseValue as-is if it doesn't need transformation
    return responseValue;
  });
