import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../lib/db.js";
import Message from "../models/Message.js";

async function runMigration() {
  try {
    console.log("Connecting to database for System Messages migration...");
    await connectDB();

    console.log("Running idempotent System Messages migration...");

    // Identify crew inaugural/system messages:
    // 1. senderRole === "System"
    // 2. crew message with text matching inaugural pattern ("assembled!" and "Let's set sail!")
    const query = {
      $or: [
        { senderRole: "System" },
        {
          $and: [
            { crewId: { $ne: null } },
            { text: { $regex: /assembled!/i } },
            { text: { $regex: /Let's set sail!/i } }
          ]
        }
      ],
      isSystem: { $ne: true }
    };

    const countToUpdate = await Message.countDocuments(query);
    console.log(`Found ${countToUpdate} existing system messages needing migration.`);

    const result = await Message.updateMany(query, {
      $set: { isSystem: true }
    });

    console.log(`Successfully updated ${result.modifiedCount} system messages (isSystem: true).`);
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
