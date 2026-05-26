const BASE_URL = 'https://eclawbot.com';

async function monitor() {
    console.log(`📡 Monitoring for Incoming Messages on ${BASE_URL}...`);
    console.log("(Send a message from your Phone Widget now)");

    setInterval(async () => {
        try {
            const res = await fetch(`${BASE_URL}/api/client/pending`);
            const data = await res.json();

            if (data.count && data.count > 0) {
                console.log("\n📬 [New Message Received!]");
                data.messages.forEach(msg => {
                    console.log(`   From: ${msg.source || 'User'}`);
                    console.log(`   Text: "${msg.text}"`);
                    console.log(`   Time: ${new Date(msg.timestamp).toLocaleTimeString()}`);
                    console.log("   -----------------------------");
                });
            } else {
                process.stdout.write("."); // heartbeat
            }
        } catch (e) {
            console.error("Connection Error:", e.message);
        }
    }, 2000); // Poll every 2 seconds
}

monitor();
