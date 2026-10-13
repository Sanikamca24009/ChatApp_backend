import mongoose from "mongoose";

const crewSchema = new mongoose.Schema({
    name: { type: String, required: true },
    flag: { type: String, default: "🏴‍☠️" },
    captain: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    members: [
        {
            user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
            role: { type: String, enum: ["Captain", "First Mate", "Crewmate"], default: "Crewmate" },
        }
    ],
}, { timestamps: true });

const Crew = mongoose.model("Crew", crewSchema);

export default Crew;
