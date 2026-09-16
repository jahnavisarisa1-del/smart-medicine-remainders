from flask import Flask, render_template, request, redirect, url_for, jsonify
import sqlite3
from datetime import date
from pathlib import Path
from difflib import SequenceMatcher

app = Flask(__name__, template_folder=".")

DATABASE = str(Path(__file__).resolve().parent / "medicine.db")

HEALTH_LIBRARY = [
    {
        "kind": "Disease",
        "name": "Type 2 diabetes",
        "keywords": "diabetes blood sugar glucose insulin thirst urination",
        "summary": "A long-term condition in which blood glucose stays higher than recommended.",
        "suggestions": "Track glucose as directed, take prescribed treatment consistently, and discuss nutrition and activity with your clinician.",
        "warning": "Seek urgent help for confusion, fainting, severe vomiting, or signs of very high or low blood sugar.",
    },
    {
        "kind": "Disease",
        "name": "Hypertension",
        "keywords": "high blood pressure hypertension headache heart",
        "summary": "Blood pressure that remains above the range recommended for a person.",
        "suggestions": "Record readings accurately, take prescribed medicines, and review salt, activity, sleep, and follow-up with a clinician.",
        "warning": "Chest pain, severe breathlessness, weakness on one side, or sudden vision changes need emergency care.",
    },
    {
        "kind": "Disease",
        "name": "Asthma",
        "keywords": "asthma wheeze breathing lungs inhaler allergy",
        "summary": "A condition where the airways can become inflamed and narrowed.",
        "suggestions": "Keep your prescribed reliever available, know your written action plan, and reduce known triggers.",
        "warning": "Severe breathing difficulty, blue lips, or poor response to a reliever is an emergency.",
    },
    {
        "kind": "Medicine",
        "name": "Metformin",
        "keywords": "metformin diabetes glucose tablet",
        "summary": "A prescription medicine commonly used to help manage type 2 diabetes.",
        "suggestions": "Use only as prescribed and ask a pharmacist about stomach upset, missed doses, or interactions.",
        "warning": "Do not change or stop treatment without medical advice; urgent symptoms require professional care.",
    },
    {
        "kind": "Medicine",
        "name": "Paracetamol",
        "keywords": "paracetamol acetaminophen pain fever",
        "summary": "A medicine commonly used for pain or fever when suitable for the person taking it.",
        "suggestions": "Check the label and avoid combining products that contain the same ingredient.",
        "warning": "Too much can seriously damage the liver. Contact emergency services after an overdose.",
    },
    {
        "kind": "Medicine",
        "name": "Salbutamol inhaler",
        "keywords": "salbutamol albuterol inhaler asthma wheeze breathing",
        "summary": "A prescribed reliever inhaler that can quickly relax airway muscles.",
        "suggestions": "Use the technique taught by your clinician and review frequent use, since it may signal poor control.",
        "warning": "Severe or worsening breathing difficulty needs urgent medical attention.",
    },
]


def search_health_library(query):
    aliases = {
        "sugar": "diabetes",
        "bp": "hypertension",
        "pressure": "hypertension",
        "acetaminophen": "paracetamol",
        "albuterol": "salbutamol",
        "breathlessness": "asthma",
    }
    terms = {
        aliases.get(term.strip(".,?!"), term.strip(".,?!"))
        for term in query.lower().split()
    }
    if not terms:
        return []

    ranked = []
    for item in HEALTH_LIBRARY:
        haystack = f"{item['name']} {item['keywords']}".lower()
        score = sum(2 if term in item["name"].lower() else 1 for term in terms if term in haystack)
        if not score:
            score = max(
                (SequenceMatcher(None, term, word).ratio() for term in terms for word in haystack.split()),
                default=0,
            )
            score = 1 if score >= 0.78 else 0
        if score:
            ranked.append((score, item))
    return [item for _, item in sorted(ranked, key=lambda result: result[0], reverse=True)[:6]]


# =========================
# DATABASE CONNECTION
# =========================

def get_db():
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    return conn


# =========================
# CREATE DATABASE
# =========================

def init_db():
    conn = get_db()

    conn.execute("""
        CREATE TABLE IF NOT EXISTS medicines (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            dosage TEXT,
            time TEXT,
            medicine_date TEXT,
            remaining_doses INTEGER DEFAULT 1,
            taken INTEGER DEFAULT 0,
            reminder_enabled INTEGER DEFAULT 1
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS profiles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            firebase_uid TEXT UNIQUE,
            email TEXT,
            name TEXT NOT NULL,
            age INTEGER,
            blood_group TEXT,
            allergies TEXT,
            emergency_contact TEXT,
            medical_info TEXT,
            diseases TEXT,
            medicines TEXT
        )
    """)

    # Add fields to databases created by older versions of the app.
    for table, column, definition in (
        ("medicines", "reminder_enabled", "INTEGER DEFAULT 1"),
        ("profiles", "firebase_uid", "TEXT"),
        ("profiles", "email", "TEXT"),
        ("profiles", "diseases", "TEXT"),
        ("profiles", "medicines", "TEXT"),
    ):
        columns = {
            row[1]
            for row in conn.execute(f"PRAGMA table_info({table})").fetchall()
        }
        if column not in columns:
            conn.execute(
                f"ALTER TABLE {table} ADD COLUMN {column} {definition}"
            )
    conn.commit()
    conn.close()
# =========================
# HOME PAGE
# =========================

@app.route("/")
def home():

    conn = get_db()

    profile = conn.execute("""
        SELECT *
        FROM profiles
        ORDER BY id DESC
        LIMIT 1
    """).fetchone()

    medicines = conn.execute("""
        SELECT *
        FROM medicines
        WHERE medicine_date = ?
        ORDER BY time
    """, (str(date.today()),)).fetchall()

    conn.close()

    # Calculate adherence
    if medicines:
        taken_count = sum(medicine["taken"] for medicine in medicines)
        adherence = int((taken_count / len(medicines)) * 100)
    else:
        adherence = 0

    return render_template(
        "frontend.html",
        profile=profile,
        medicines=medicines,
        adherence=adherence,
        today=str(date.today())
    )


@app.route("/frontend.html")
def frontend_page():
    return redirect(url_for("home"))


@app.route("/backend.html")
def backend_page():
    return redirect(url_for("create_profile"))


# =========================
# CREATE PROFILE
# =========================

@app.route("/create_profile", methods=["GET", "POST"])
def create_profile():

    if request.method == "POST":

        name = request.form.get("full_name", "").strip()
        age = request.form.get("age", "").strip() or None
        blood_group = request.form.get("blood_group")
        allergies = request.form.get("allergies")
        emergency_contact = request.form.get("emergency_contact")
        medical_info = request.form.get("medical_info")
        diseases = request.form.get("diseases")
        medicines = request.form.get("medicines")
        firebase_uid = request.form.get("firebase_uid", "").strip() or None
        email = request.form.get("email", "").strip().lower() or None

        if not name:
            return "Full name is required.", 400
        if not firebase_uid and not email:
            return "Firebase UID or email is required to link the profile.", 400

        try:
            age = int(age) if age is not None else None
        except ValueError:
            return "Age must be a number.", 400

        if age is not None and not 0 < age <= 130:
            return "Age must be between 1 and 130.", 400

        conn = get_db()

        existing_profile = conn.execute(
            "SELECT id FROM profiles WHERE firebase_uid = ? OR (firebase_uid IS NULL AND email = ?) LIMIT 1",
            (firebase_uid, email),
        ).fetchone()

        values = (
            firebase_uid,
            email,
            name,
            age,
            blood_group,
            allergies,
            emergency_contact,
            medical_info,
            diseases,
            medicines,
        )

        if existing_profile:
            conn.execute("""
                UPDATE profiles
                SET firebase_uid = ?, email = ?, name = ?, age = ?, blood_group = ?, allergies = ?,
                    emergency_contact = ?, medical_info = ?, diseases = ?,
                    medicines = ?
                WHERE id = ?
            """, values + (existing_profile["id"],))
        else:
            conn.execute("""
                INSERT INTO profiles
                (firebase_uid, email, name, age, blood_group, allergies,
                 emergency_contact, medical_info, diseases, medicines)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, values)

        conn.commit()
        conn.close()

        return redirect(url_for("home"))

    return render_template("backend.html")


@app.route("/api/patient-profile", methods=["GET", "POST"])
def patient_profile_api():
    data = request.get_json(silent=True) or {}
    firebase_uid = str(data.get("firebase_uid") or "").strip() or None
    email = str(data.get("email") or "").strip().lower() or None
    if not firebase_uid and not email:
        return jsonify({"success": False, "error": "firebase_uid or email is required"}), 400

    conn = get_db()
    identity_query = "SELECT * FROM profiles WHERE firebase_uid = ? LIMIT 1" if firebase_uid else "SELECT * FROM profiles WHERE firebase_uid IS NULL AND email = ? LIMIT 1"
    identity_params = (firebase_uid,) if firebase_uid else (email,)
    if request.method == "GET":
        profile = conn.execute(identity_query, identity_params).fetchone()
        conn.close()
        if not profile:
            return jsonify({"success": False, "error": "Profile not found"}), 404
        return jsonify({"success": True, "profile": dict(profile)})

    profile = data.get("profile") or {}
    if not profile.get("name"):
        conn.close()
        return jsonify({"success": False, "error": "Patient name is required"}), 400
    existing = conn.execute(identity_query, identity_params).fetchone()
    values = (
        firebase_uid,
        email,
        profile["name"],
        profile.get("age"),
        profile.get("blood_group"),
        profile.get("allergies"),
        profile.get("emergency_contact"),
        profile.get("medical_info"),
        ",".join(profile.get("diseases", [])) if isinstance(profile.get("diseases"), list) else profile.get("diseases"),
        str(data.get("reminders") or data.get("medicines") or profile.get("medicines") or []),
    )
    if existing:
        conn.execute("""
            UPDATE profiles SET firebase_uid = ?, email = ?, name = ?, age = ?, blood_group = ?,
                allergies = ?, emergency_contact = ?, medical_info = ?, diseases = ?, medicines = ?
            WHERE id = ?
        """, values + (existing["id"],))
    else:
        conn.execute("""
            INSERT INTO profiles
                (firebase_uid, email, name, age, blood_group, allergies, emergency_contact,
                 medical_info, diseases, medicines)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, values)
    conn.commit()
    saved = conn.execute(identity_query, identity_params).fetchone()
    conn.close()
    return jsonify({"success": True, "profile": dict(saved)})


# =========================
# ADD MEDICINE
# =========================

@app.route("/add_medicine", methods=["POST"])
def add_medicine():

    name = request.form.get("name", "").strip()
    dosage = request.form.get("dosage")
    time = request.form.get("time")
    medicine_date = request.form.get("date")
    total_doses = request.form.get("total_doses")

    if not name or not time:
        return "Medicine name and reminder time are required.", 400

    if not medicine_date:
        medicine_date = str(date.today())

    try:
        total_doses = int(total_doses)
    except (ValueError, TypeError):
        total_doses = 1

    total_doses = max(1, total_doses)

    conn = get_db()

    conn.execute("""
        INSERT INTO medicines
        (
            name,
            dosage,
            time,
            medicine_date,
            remaining_doses,
            taken
        )
        VALUES (?, ?, ?, ?, ?, ?)
    """, (
        name,
        dosage,
        time,
        medicine_date,
        total_doses,
        0
    ))

    conn.commit()
    conn.close()

    return redirect(url_for("home"))


# =========================
# TAKE / UNTAKE MEDICINE
# =========================

@app.route("/medicine/<int:medicine_id>/toggle", methods=["POST"])
def toggle_medicine(medicine_id):

    conn = get_db()

    medicine = conn.execute("""
        SELECT *
        FROM medicines
        WHERE id = ?
    """, (medicine_id,)).fetchone()

    if medicine:

        if medicine["taken"] == 0:

            remaining = max(
                0,
                medicine["remaining_doses"] - 1
            )

            conn.execute("""
                UPDATE medicines
                SET remaining_doses = ?,
                    taken = 1
                WHERE id = ?
            """, (
                remaining,
                medicine_id
            ))

        else:

            conn.execute("""
                UPDATE medicines
                SET remaining_doses = remaining_doses + 1,
                    taken = 0
                WHERE id = ?
            """, (medicine_id,))

        conn.commit()

    conn.close()

    return jsonify({"success": True})


# =========================
# DELETE MEDICINE
# =========================

@app.route("/delete_medicine/<int:medicine_id>", methods=["POST"])
def delete_medicine(medicine_id):

    conn = get_db()

    conn.execute("""
        DELETE FROM medicines
        WHERE id = ?
    """, (medicine_id,))

    conn.commit()
    conn.close()

    return redirect(url_for("home"))


# =========================
# AI DEMO
# =========================

@app.route("/ai", methods=["POST"])
def ai():

    data = request.get_json(silent=True) or {}

    question = data.get("question", "")

    if question.strip() == "":
        return jsonify({"answer": "Enter a disease or medicine name to search the health library.", "results": []})

    results = search_health_library(question)
    if results:
        answer = "These are educational matches. They are not a diagnosis or a prescription."
    else:
        answer = "No close match found. Try a medicine name, condition, symptom, or ask a pharmacist or clinician."

    return jsonify({
        "answer": answer,
        "results": results
    })


# =========================
# RUN APPLICATION
# =========================

if __name__ == "__main__":
    init_db()
    app.run(debug=True)