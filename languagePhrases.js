const languagePhrases = {
    "en-US": { reminder: (medicine) => `It's time to take ${medicine}.`, confirmations: ["okay", "ok", "done", "taken", "yes"] },
    "hi-IN": { reminder: (medicine) => `${medicine} लेने का समय हो गया है।`, confirmations: ["हो गया", "ठीक है", "ले लिया", "हाँ", "खा लिया", "दवाई ले ली"] },
    "te-IN": { reminder: (medicine) => `${medicine} తీసుకునే సమయం అయింది.`, confirmations: ["సరే", "అయిపోయింది", "తీసుకున్నాను", "వేసుకున్నాను", "ఔను"] },
    "ta-IN": { reminder: (medicine) => `${medicine} எடுத்துக்கொள்ளும் நேரம் இது.`, confirmations: ["ஆயிற்று", "சரி", "எடுத்துவிட்டேன்", "சாப்பிட்டேன்", "ஆமாம்", "முடிந்தது"] },
    "ml-IN": { reminder: (medicine) => `${medicine} കഴിക്കേണ്ട സമയമായി.`, confirmations: ["കഴിച്ചു", "ശരി", "ആയി", "എടുത്തു", "അതെ"] },
    "kn-IN": { reminder: (medicine) => `${medicine} ತೆಗೆದುಕೊಳ್ಳುವ ಸಮಯವಾಗಿದೆ.`, confirmations: ["ಆಯಿತು", "ಸರಿ", "ತೆಗೆದುಕೊಂಡೆ"] },
    "fil-PH": { reminder: (medicine) => `Oras na para inumin ang ${medicine}.`, confirmations: ["okay", "tapos na", "nainom na"] }
};