/**
 * Concurrent WebSocket Message Load Test
 * 
 * This test connects to the WebSocket server and sends a large number of messages
 * concurrently to test server performance and message handling under load.
 * 
 * How to use:
 * 1. Fill in the configuration values below (TOKEN, FROM_CONVERSATION_ID, TO_CONVERSATION_ID)
 * 2. Ensure your WebSocket server is running on the configured port (default: 5002)
 * 3. Run with: bun run src/tests/concurrent-messages.test.js
 * 
 * The test will:
 * - Connect to the WebSocket server
 * - Join the target conversation
 * - Send 1000 messages concurrently
 * - Track and report metrics (sent, received, acknowledged, errors, throughput)
 */

// ========================================
// CONFIGURATION - FILL THESE VALUES
// ========================================
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6NzY5NTQ1NDQyMSwicm9sZSI6InVzZXIiLCJpYXQiOjE3NjE1NTYyMTYsImV4cCI6MTc2MjE2MTAxNn0.v1tiHDF1aC_7LCtTK8iy7VLjRU0w-4jm3r0pnjCzKrg'; // Replace with your actual JWT token
const CONV_ID = 9787445984;
const FROM_USER_ID = 3961164275; // Replace with the conversation ID to send from
const TO_USER_ID = 2265806948; // Replace with the conversation ID to send to 
// WebSocket runs on a separate port (5002 by default) with path /chat (no /api prefix)
// For production with reverse proxy, it might be available at different paths
// const WEBSOCKET_URL = 'ws://api.amigochats.com:5002/chat'; // Use ws:// (not wss://) for direct port connection
const WEBSOCKET_URL = 'ws://localhost:5002/chat'; // Use ws:// (not wss://) for direct port connection
// Alternative URLs to try if above doesn't work:
// 'wss://api.amigochats.com/chat' (if proxied through reverse proxy on port 443)
// 'ws://localhost:5002/chat' (for local testing)
const TOTAL_MESSAGES = 1000; // Number of messages to send concurrently
// ========================================

let sentMessages = 0;
let receivedMessages = 0;
let errorCount = 0;
let messagesAcknowledged = 0;
const startTime = Date.now();
let ws;

async function runTest() {
  try {
    const fullUrl = `${WEBSOCKET_URL}?token=${encodeURIComponent(TOKEN)}`;
    console.log(`🔗 Connecting to: ${fullUrl.replace(TOKEN, '[TOKEN]')}`);

    // Connect to WebSocket
    ws = new WebSocket(fullUrl);

    ws.addEventListener('open', () => {
      console.log('✅ Connected to WebSocket server');
      console.log(`📤 Starting to send ${TOTAL_MESSAGES} messages concurrently...\n`);

      // Join the conversation
      ws.send(JSON.stringify({
        type: 'join_conversation',
        conversation_id: CONV_ID
      }));

      // Wait a bit for the join to complete, then send all messages concurrently
      setTimeout(() => {
        const sendStart = Date.now();

        // Send all messages concurrently
        for (let i = 1; i <= TOTAL_MESSAGES; i++) {
          const message = {
            type: 'message',
            conversation_id: CONV_ID,
            data: {
              type: 'text',
              body: `Test message ${i} of ${TOTAL_MESSAGES}`,
              optimistic_id: -i
            }
          };

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
            sentMessages++;

            if (i % 100 === 0 || i === 1 || i === TOTAL_MESSAGES) {
              console.log(`📈 Sent ${sentMessages}/${TOTAL_MESSAGES} messages`);
            }
          } else {
            console.error(`❌ WebSocket not open. ReadyState: ${ws.readyState}`);
            errorCount++;
            break;
          }
        }

        const sendEnd = Date.now();
        console.log(`\n⚡ Finished sending all messages in ${((sendEnd - sendStart) / 1000).toFixed(3)} seconds`);
        console.log(`📤 Total sent: ${sentMessages} messages`);
      }, 100); // Small delay to ensure join_conversation is processed
    });

    ws.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data);
        receivedMessages++;

        if (message.type === 'message' || message.type === 'message_delivery_receipt') {
          messagesAcknowledged++;
        }

        if (message.type === 'error') {
          errorCount++;
          console.error(`❌ Error from server: ${message.data?.message || 'Unknown error'}`);
        }

        // Progress report
        if (receivedMessages % 100 === 0 || receivedMessages === 1) {
          console.log(`📥 Received ${receivedMessages} responses, ${messagesAcknowledged} acknowledged`);
        }
      } catch (error) {
        console.error('Error parsing message:', error);
      }
    });

    ws.addEventListener('error', (error) => {
      console.error('❌ WebSocket error:', error);
      console.error('Error details:', error.message || 'Unknown error');
      errorCount++;
    });

    ws.addEventListener('close', (event) => {
      const endTime = Date.now();
      const duration = (endTime - startTime) / 1000;

      console.log('\n' + '='.repeat(60));
      console.log('📊 TEST RESULTS');
      console.log('='.repeat(60));
      console.log(`⏱️  Total duration: ${duration.toFixed(2)} seconds`);
      console.log(`📤 Messages sent: ${sentMessages}`);
      console.log(`📥 Total responses received: ${receivedMessages}`);
      console.log(`✅ Messages acknowledged: ${messagesAcknowledged}`);
      console.log(`❌ Errors: ${errorCount}`);
      console.log(`📈 Messages per second: ${(sentMessages / duration).toFixed(2)}`);
      console.log(`🔌 Close code: ${event.code}`);
      console.log(`📝 Close reason: ${event.reason || 'N/A'}`);
      console.log('='.repeat(60));

      if (event.code === 1002 || event.code === 1006) {
        console.log('\n💡 Troubleshooting tips:');
        console.log('1. Check if the WebSocket server is running');
        console.log('2. Verify the WebSocket URL is correct');
        console.log('3. Try: ws://localhost:5002/chat for local testing');
        console.log('4. Check server logs for authentication/connection errors');
      }

      process.exit(0);
    });

  } catch (error) {
    console.error('❌ Failed to create WebSocket connection:', error);
    process.exit(1);
  }
}

// Handle process termination
process.on('SIGINT', () => {
  console.log('\n🛑 Interrupted by user');
  if (ws) {
    ws.close();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Terminated');
  if (ws) {
    ws.close();
  }
  process.exit(0);
});

// Run the test
runTest();

