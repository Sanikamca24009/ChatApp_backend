import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../lib/db.js";
import Message from "../models/Message.js";

async function runMigration() {
  try {
    console.log("Connecting to database for Message Status migration...");
    await connectDB();

    console.log("Running idempotent Message Status migration...");

    // 1. Where seen === true and status is missing or not a valid status
    const seenResult = await Message.updateMany(
      {
        seen: true,
        $or: [
          { status: { $exists: false } },
          { status: null },
          { status: { $nin: ["sent", "delivered", "seen"] } }
        ]
      },
      {
        $set: { status: "seen" }
      }
    );
    console.log(`Updated ${seenResult.modifiedCount} messages (seen: true) -> status: 'seen'.`);

    // 2. Where status is still missing or not a valid status
    const sentResult = await Message.updateMany(
      {
        $or: [
          { status: { $exists: false } },
          { status: null },
          { status: { $nin: ["sent", "delivered", "seen"] } }
        ]
      },
      {
        $set: { status: "sent" }
      }
    );
    console.log(`Updated ${sentResult.modifiedCount} messages -> status: 'sent'.`);

    console.log("Migration completed successfully!");
  } catch (error) {
    console.error("Migration failed:", error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log("Database disconnected.");
  }
}

runMigration();
