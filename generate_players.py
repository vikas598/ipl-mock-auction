import pandas as pd
import json

# --- CONFIGURATION ---
INPUT_FILE = 'list.csv' # REPLACE with your actual file name
OUTPUT_FILE = 'players.js'

def clean_player_data(row, index):  
    # 1. Extract Raw Data
    name = str(row['Name']).strip()
    country = str(row['Country']).strip()
    role = str(row['Role']).strip()
    category = str(row['C/U/A']).strip()
    price_val = row['Price Rs(Lakh)']

    # 2. Handle Price (Convert Lakhs to Full Number)
    # Handle cases where price might be missing or mixed with other columns
    base_price = 20000000 # Default fallback (2 Cr)
    try:
        if pd.notna(price_val):
            base_price = int(float(price_val) * 100000)
    except:
        base_price = 20000000

    # 3. Normalize Nationality
    nationality = 'Indian' if country.lower() == 'india' else 'Overseas'

    # 4. Normalize Role (Standardize to 4 types)
    role_lower = role.lower()
    if 'wicket' in role_lower:
        final_role = 'Wicket-keeper'
    elif 'all' in role_lower:
        final_role = 'All-rounder'
    elif 'bowl' in role_lower:
        final_role = 'Bowler'
    else:
        final_role = 'Batsman'

    # 5. Normalize Category (Capped/Uncapped)
    # Some rows might have typos or numeric values
    cat_lower = category.lower()
    if 'uncapped' in cat_lower:
        final_category = 'Uncapped'
    else:
        final_category = 'Capped'

    # 6. Generate ID (P001, P002...)
    player_id = f"P{index+1:03d}"

    return {
        "id": player_id,
        "name": name,
        "role": final_role,
        "nationality": nationality,
        "category": final_category,
        "base_price": base_price,
        "image": "https://via.placeholder.com/150" # Placeholder image
    }

def main():
    try:
        print(f"Reading {INPUT_FILE}...")
        df = pd.read_csv(INPUT_FILE)
        
        # Process all rows
        print(f"Processing {len(df)} players...")
        all_players = []
        for index, row in df.iterrows():
            player = clean_player_data(row, index)
            all_players.append(player)

        # Convert to JSON string
        json_data = json.dumps(all_players, indent=4)
        
        # Add the module.exports prefix for Node.js
        final_content = f"module.exports = {json_data};"

        # Write to file
        with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
            f.write(final_content)

        print(f"Success! Generated {OUTPUT_FILE} with {len(all_players)} players.")
        print("You can now move 'players.js' to your website folder.")

    except FileNotFoundError:
        print(f"Error: Could not find '{INPUT_FILE}'. Make sure the CSV file is in the same folder.")
    except Exception as e:
        print(f"An error occurred: {e}")

if __name__ == "__main__":
    main()