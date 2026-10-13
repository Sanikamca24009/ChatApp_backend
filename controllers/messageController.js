import Message from "../models/Message.js";
import User from "../models/User.js";
import cloundinary from "../lib/cloudinary.js";
import { io, userSocketMap } from "../server.js";

// get users who are mutual followers (both have followed each other)
export const getUserForSidebar = async (req, res)=>{
    try {
        const userId = req.user._id.toString();
        const currentUser = await User.findById(userId);
        if (!currentUser) {
            return res.json({ success: false, message: "User not found" });
        }

        const myFollowing = (currentUser.following || []).map(id => id.toString());
        const myFollowers = (currentUser.followers || []).map(id => id.toString());

        // Find users that are mutual follows (both follow each other)
        const mutualUserIds = myFollowing.filter(id => myFollowers.includes(id));

        const mutualUsers = await User.find({ _id: { $in: mutualUserIds } }).select("-password");

        // count number of messages not seen
        const unseenMessages = {}
        const promises = mutualUsers.map(async (user)=>{
            const messages = await Message.find({senderId: user._id, receiverId: userId, seen: false})
            if(messages.length > 0){
                unseenMessages[user._id] = messages.length;
            }
        })

        await Promise.all(promises)
        res.json({success: true, users: mutualUsers, unseenMessages})

    } catch (error) {
        console.log(error.message)
        res.json({success: false, message: error.message})
    }
}

// Get all message for selected users
export const getMessages = async (req, res) =>{
    try {
        const {id : selectedUserId } = req.params;
        const myId = req.user._id;

        const messages = await Message.find({
            $or:  [
                {senderId: myId, receiverId: selectedUserId},
                {senderId: selectedUserId, receiverId: myId},
            ]
        })
        await Message.updateMany({senderId: selectedUserId , receiverId: myId},{seen: true});

        res.json({success: true, messages})
    } catch (error) {
        console.log(error.message)
        res.json({success: false, message: error.message})
    }
}

// api to mark message as seen using message id

export const markMessageAsSeen = async (req, res) =>{
    try {
        const { id } = req.params;
        await Message.findByIdAndUpdate(id, {seen: true})
        res.json({success: true})

    } catch (error) {
        console.log(error.message)
        res.json({success: false, message: error.message})
    }
}

// Send message to selected user 
export const sendMessage = async (req, res)=>{
try {
    const {image, text } = req.body;
    const receiverId = req.params.id;
    const senderId = req.user._id;
    
    let imageUrl;
    if(image){
        const uploadResponse = await cloundinary.uploader.upload(image)
        imageUrl = uploadResponse.secure_url;

    }

    const newMessage = await Message.create({
        senderId,
        receiverId,
        text,
        image: imageUrl
    })

    // Emit the new message to the reciever's socket 
    const receiverSocketId = userSocketMap[receiverId];
    if(receiverSocketId){
        io.to(receiverSocketId).emit("newMessage", newMessage)
    }


    res.json({success: true, newMessage});
      
} catch (error) {
    console.log(error.message)
    res.json({success: false, message: error.message})
}
}