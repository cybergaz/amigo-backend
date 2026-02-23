/**
 * Recursively converts all BigInt values in an object/array to strings.
 * This is necessary because JSON.stringify cannot serialize BigInt values.
 * 
 * @param value - The value to convert (can be any type)
 * @returns The value with all BigInt values converted to strings
 */
export function convertBigIntToString(value: any): any {
  // Handle null and undefined
  if (value === null || value === undefined) {
    return value;
  }

  // Handle BigInt directly
  if (typeof value === 'bigint') {
    return value.toString();
  }

  // Handle Date objects (preserve as-is, Elysia handles them)
  if (value instanceof Date) {
    return value;
  }

  // Handle arrays
  if (Array.isArray(value)) {
    return value.map(item => convertBigIntToString(item));
  }

  // Handle objects
  if (typeof value === 'object') {
    // Handle special objects that shouldn't be converted
    if (value instanceof Buffer || value instanceof Uint8Array) {
      return value;
    }

    const converted: any = {};
    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        converted[key] = convertBigIntToString(value[key]);
      }
    }
    return converted;
  }

  // Return primitive values as-is
  return value;
}

/**
 * Recursively converts string ID values (that represent BigInt) back to BigInt.
 * This is useful when receiving data from clients or parsing JSON that has BigInt values as strings.
 * 
 * @param value - The value to convert (can be any type)
 * @returns The value with all string ID values converted to BigInt
 * 
 * Note: This function assumes that any string field that looks like an ID (e.g., ends with _id) should be converted to BigInt.
 */
export function convertStringToBigInt(value: any): any {
  // Handle null and undefined
  if (value === null || value === undefined) {
    return value;
  }

  // Handle arrays
  if (Array.isArray(value)) {
    return value.map(item => convertStringToBigInt(item));
  }

  // Handle objects
  if (typeof value === 'object') {
    // Handle special objects that shouldn't be converted
    if (value instanceof Date || value instanceof Buffer || value instanceof Uint8Array) {
      return value;
    }

    const converted: any = {};
    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const stringKey = key.toString();

        // Check if this is an ID field that should be converted from string to BigInt
        if (isIdField(stringKey)) {
          const val = value[key];

          if (typeof val === 'string') {
            // Try to parse as BigInt (handles large integer strings)
            try {
              // Check if the string represents a valid integer
              if (/^-?\d+$/.test(val)) {
                converted[stringKey] = BigInt(val);
              } else {
                // If parsing fails, keep original value and recurse
                converted[stringKey] = convertStringToBigInt(val);
              }
            } catch {
              // If BigInt conversion fails, keep original value and recurse
              converted[stringKey] = convertStringToBigInt(val);
            }
          } else if (Array.isArray(val)) {
            // Handle arrays of IDs (e.g., forwarded_to)
            // Convert each string item in the array to BigInt
            converted[stringKey] = val.map((item: any) => {
              if (typeof item === 'string' && /^-?\d+$/.test(item)) {
                try {
                  return BigInt(item);
                } catch {
                  return convertStringToBigInt(item);
                }
              }
              return convertStringToBigInt(item);
            });
          } else {
            // Not a string or array - recurse to handle nested structures
            converted[stringKey] = convertStringToBigInt(val);
          }
        } else {
          // Not an ID field - recurse to handle nested structures
          converted[stringKey] = convertStringToBigInt(value[key]);
        }
      }
    }

    return converted;
  }

  // Return primitive values as-is
  return value;
}

/**
 * Check if a field name is an ID field that should be converted from string to BigInt
 * @param fieldName - The field name to check
 * @returns True if the field is an ID field
 */
function isIdField(fieldName: string): boolean {
  // Common ID field patterns
  const idFields = [
    'id',
    'new_id',
    'message_id',
    'message_ids',
    'last_message_id',
    'last_read_message_id',
    'last_delivered_message_id',
    'lasthistory_delivered_message_id',
    'pinned_message_id',
    'reply_to_message_id',
    'forward_message_id',
    'forward_message_ids',
    'newId',
    'messageId',
    'messageIds',
    'lastMessageId',
    'lastReadMessageId',
    'lastDeliveredMessageId',
    'lasthistoryDeliveredMessageId',
    'pinnedMessageId',
    'replyToMessageId',
    'forwardMessageId',
    'forwardMessageIds'
  ];

  // Check exact match
  if (idFields.includes(fieldName)) {
    return true;
  }

  // Check if field name ends with _id
  // if (fieldName.endsWith('_id')) {
  //   return true;
  // }

  return false;
}
