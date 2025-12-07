import pandas as pd
import json

# --- CONFIGURATION ---
INPUT_FILE = 'list.csv' 
OUTPUT_FILE = 'players.js'

def clean_player_data(row, index):
    # 1. Extract Basic Data
    name = str(row['Name']).strip()
    country = str(row['Country']).strip()
    role = str(row['Role']).strip()
    category = str(row['C/U/A']).strip()
    price_val = row['Price Rs(Lakh)']
    
    # 2. NEW: Extract Age and Previous Team
    age = str(row['Age']).strip()
    if age.lower() == 'nan': age = '-'
    
    team = str(row['Team']).strip()
    if team.lower() == 'nan': team = '-'

    # 3. Extract MARQUEE Column
    marquee_val = str(row.get('Marquee', 'No')).strip().lower()
    is_marquee = marquee_val in ['yes', 'y', 'true', '1']

    # 4. Handle Price
    base_price = 20000000 
    try:
        if pd.notna(price_val):
            base_price = int(float(price_val) * 100000)
    except:
        base_price = 20000000

    # 5. Normalize Nationality
    nationality = 'Indian' if country.lower() == 'india' else 'Overseas'

    # 6. Normalize Role
    role_lower = role.lower()
    if 'wicket' in role_lower: final_role = 'Wicket-keeper'
    elif 'all' in role_lower: final_role = 'All-rounder'
    elif 'bowl' in role_lower: final_role = 'Bowler'
    else: final_role = 'Batsman'

    # 7. Normalize Category
    cat_lower = category.lower()
    final_category = 'Uncapped' if 'uncapped' in cat_lower else 'Capped'

    return {
        "id": f"P{index+1:03d}",
        "name": name,
        "role": final_role,
        "nationality": nationality,
        "category": final_category,
        "base_price": base_price,
        "marquee": is_marquee,
        "age": age,          # <--- New Field
        "prev_team": team,   # <--- New Field
        "image": "https://via.placeholder.com/150"
    }

def main():
    try:
        print(f"Reading {INPUT_FILE}...")
        df = pd.read_csv(INPUT_FILE)
        
        all_players = []
        for index, row in df.iterrows():
            player = clean_player_data(row, index)
            all_players.append(player)

        json_data = json.dumps(all_players, indent=4)
        final_content = f"module.exports = {json_data};"

        with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
            f.write(final_content)

        print(f"Success! Processed {len(all_players)} players with Age & Team data.")

    except FileNotFoundError:
        print(f"Error: Could not find '{INPUT_FILE}'.")
    except Exception as e:
        print(f"An error occurred: {e}")

if __name__ == "__main__":
    main()