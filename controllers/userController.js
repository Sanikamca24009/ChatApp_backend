import cloundinary from "../lib/cloudinary.js";
import { generateToken } from "../lib/utils.js";
import User from "../models/User.js";
import bcrypt from "bcryptjs";


//SignUp new user

export const Signup = async(req, res)=>{
    const {fullName, email, password, bio} = req.body;

    try {
        if(!fullName || !email || !password || !bio){
            return res.json({success: false, message: "Missing Details"})
        }
        const user = await User.findOne({email});

        if(user){
            return res.json({success: false, message:"Account already exists"})

        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = await User.create({
            fullName, email, password: hashedPassword, bio
        });

        const token = generateToken(newUser._id)
        res.json({success: true, userData: newUser, token, message: "Account created successfully"})
    } catch (error) {
        console.log(error.message);
        res.json({success: false, message: error.message})
    }
}

//controller to login a user 
export const login = async (req, res)=>{
    try {
        const {email, password } = req.body;
        if(!email || !password){
            return res.json({success: false, message: "Please provide both email and password"});
        }

        const userData = await User.findOne({email});
        if(!userData){
            return res.json({success: false, message: "User does not exist. Please create an account first."});
        }

        const isPasswordCorrect = await bcrypt.compare(password, userData.password);

        if(!isPasswordCorrect){
            return res.json({success: false, message:"Invalid credential"});
        }

        const token = generateToken(userData._id)
        res.json({success: true, userData, token, message: "Login successfully"})
    } catch (error) {
        console.log(error.message);
        res.json({success: false, message: error.message})
    }
}

//Controller to check if user is authenticated

export const checkAuth = (req, res)=>{
    res.json({success: true, user: req.user});
}

// Controller to update user profile details 
export const updateProfile = async (req, res)=>{
    try {
        const { profilePic, bio, fullName } = req.body;

        const userId = req.user._id;
        let updatedUser;

        if(!profilePic){
            updatedUser =  await User.findByIdAndUpdate(userId, {bio, fullName}, {new: true});
        }else{
            const upload = await cloundinary.uploader.upload(profilePic);

            updatedUser = await User.findByIdAndUpdate(userId, {profilePic: upload.secure_url, bio, fullName},{new: true})
        }

        res.json({success: true, user:updatedUser})

    } catch (error) {
        console.log(error.message)
        res.json({success: false, message: error.message})
    }
}

// Controller to get all users with follow status for discovery
export const getAllUsers = async (req, res) => {
    try {
        const myId = req.user._id.toString();
        const currentUser = await User.findById(myId);
        if (!currentUser) {
            return res.json({ success: false, message: "User not found" });
        }

        const myFollowing = (currentUser.following || []).map(id => id.toString());
        const myFollowers = (currentUser.followers || []).map(id => id.toString());

        const users = await User.find({ _id: { $ne: myId } }).select("-password");

        const formattedUsers = users.map(u => {
            const uId = u._id.toString();
            const isFollowing = myFollowing.includes(uId);
            const isFollower = myFollowers.includes(uId);
            const isMutual = isFollowing && isFollower;

            return {
                _id: u._id,
                fullName: u.fullName,
                email: u.email,
                profilePic: u.profilePic,
                bio: u.bio,
                lastSeen: u.lastSeen,
                isFollowing,
                isFollower,
                isMutual,
            };
        });

        res.json({ success: true, users: formattedUsers });
    } catch (error) {
        console.log(error.message);
        res.json({ success: false, message: error.message });
    }
};

// Controller to follow or unfollow a user
export const toggleFollowUser = async (req, res) => {
    try {
        const myId = req.user._id;
        const targetId = req.params.id;

        if (myId.toString() === targetId.toString()) {
            return res.json({ success: false, message: "You cannot follow yourself" });
        }

        const currentUser = await User.findById(myId);
        const targetUser = await User.findById(targetId);

        if (!targetUser) {
            return res.json({ success: false, message: "User not found" });
        }

        const isCurrentlyFollowing = (currentUser.following || []).some(
            id => id.toString() === targetId.toString()
        );

        if (isCurrentlyFollowing) {
            // Unfollow
            currentUser.following = (currentUser.following || []).filter(
                id => id.toString() !== targetId.toString()
            );
            targetUser.followers = (targetUser.followers || []).filter(
                id => id.toString() !== myId.toString()
            );
        } else {
            // Follow
            if (!currentUser.following) currentUser.following = [];
            currentUser.following.push(targetId);

            if (!targetUser.followers) targetUser.followers = [];
            targetUser.followers.push(myId);
        }

        await currentUser.save();
        await targetUser.save();

        const isFollowing = !isCurrentlyFollowing;
        const targetFollowersStrings = (targetUser.followers || []).map(id => id.toString());
        const targetFollowingStrings = (targetUser.following || []).map(id => id.toString());
        const isMutual = isFollowing && targetFollowingStrings.includes(myId.toString());

        res.json({
            success: true,
            isFollowing,
            isMutual,
            message: isFollowing ? `You are now following ${targetUser.fullName}` : `Unfollowed ${targetUser.fullName}`
        });
    } catch (error) {
        console.log(error.message);
        res.json({ success: false, message: error.message });
    }
};