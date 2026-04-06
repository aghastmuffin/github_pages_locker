# Create A Private Github Page
GH pages is notoriously a public-only, "serverless" (it cannot run files, only serve preran files), solution to website hosting, and while it's great there are a couple caveats that come with that. One is access control, the aim of this project.


# Spec/Desc
## What is this? (Stage 1)
Private GH pages takes your website's code and obfuscates it behind an encryption algorithm with a principle similar to PyArmor, as python has the same issue, it's code is, by nature very easily to decrypt and get source code from. Since Python is such a big player in languages, this is a problem as so many people have business-level programs through it that require some level of privacy so that code is not just priated and distrubuted "willy-nilly." While this is more than just an obfuscator, this explains the first level of Private GH. Obfuscated code still runs on anyone's system, though, and for access control we can't just make it hard to reverse engineer what's happening, it has to be a little bit (way more) complicated. Thus comes stage 2.

## Stage 2
WASM is utilized to convert 