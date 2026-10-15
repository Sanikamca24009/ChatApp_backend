import mongoose from "mongoose";

const messageSchema = new mongoose.Schema({
    senderId: {type: mongoose.Schema.Types.ObjectId, ref:"User", required: true},
    receiverId: {type: mongoose.Schema.Types.ObjectId, ref:"User"},
    crewId: {type: mongoose.Schema.Types.ObjectId, ref:"Crew"},
    senderRole: {type: String, default: "Crewmate"},
    text: {type: String},
    image: {type: String},
    status: {type: String, enum: ["sent", "delivered", "seen"], default: "sent"},
    seen: {type: Boolean, default: false},
    seenBy: [{type: mongoose.Schema.Types.ObjectId, ref:"User"}],
    replyTo: {type: mongoose.Schema.Types.ObjectId, ref: "Message", default: null},
    isForwarded: {type: Boolean, default: false},
    isSystem: {type: Boolean, default: false},
    editedAt: {type: Date, default: null},
    deletedFor: [{type: mongoose.Schema.Types.ObjectId, ref: "User"}],
    isDeletedForAll: {type: Boolean, default: false},
    deletedAt: {type: Date, default: null},
    reactions: [
        {
            userId: {type: mongoose.Schema.Types.ObjectId, ref: "User", required: true},
            emoji: {type: String, required: true},
            createdAt: {type: Date, default: Date.now}
        }
    ]
}, {timestamps: true});

const Message = mongoose.model("Message", messageSchema);

export default Message;

