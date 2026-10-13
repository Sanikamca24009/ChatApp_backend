import mongoose from "mongoose";

const messageSchema = new mongoose.Schema({
    senderId: {type: mongoose.Schema.Types.ObjectId, ref:"User", required: true},
    receiverId: {type: mongoose.Schema.Types.ObjectId, ref:"User"},
    crewId: {type: mongoose.Schema.Types.ObjectId, ref:"Crew"},
    senderRole: {type: String, default: "Crewmate"},
    text: {type: String},
    image: {type: String},
    seen: {type: Boolean, default: false},
    seenBy: [{type: mongoose.Schema.Types.ObjectId, ref:"User"}]
}, {timestamps: true});

const Message = mongoose.model("Message", messageSchema);

export default Message;

