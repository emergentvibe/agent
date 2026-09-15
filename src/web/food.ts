import fs from 'fs';
import path from 'path';

export interface Dish {
  name: string;
  allergens: string[];
  isVegan: boolean;
}

export interface MealInfo {
  meal: 'Breakfast' | 'Lunch' | 'Dinner';
  dishes: Dish[];
}

interface DayMenu {
  date: string;
  meals: MealInfo[];
}

const MONTH_MAP: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

let cachedMenus: DayMenu[] | null = null;

function parseFood(): DayMenu[] {
  if (cachedMenus) return cachedMenus;

  const foodPath = path.resolve(process.cwd(), 'knowledge/treeweek/food.md');
  if (!fs.existsSync(foodPath)) {
    cachedMenus = [];
    return cachedMenus;
  }

  const content = fs.readFileSync(foodPath, 'utf-8');
  const dayBlocks = content.split(/^## (?=(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s)/m);
  const menus: DayMenu[] = [];

  for (const block of dayBlocks) {
    const headerMatch = block.match(/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+(\d{1,2})\s+(\w+)/);
    if (!headerMatch) continue;

    const dayNum = parseInt(headerMatch[1], 10);
    const monthName = headerMatch[2].toLowerCase();
    const month = MONTH_MAP[monthName];
    if (month === undefined) continue;

    const year = new Date().getFullYear() >= 2026 ? new Date().getFullYear() : 2026;
    const m = String(month + 1).padStart(2, '0');
    const d = String(dayNum).padStart(2, '0');
    const date = `${year}-${m}-${d}`;

    const meals: MealInfo[] = [];
    const mealTypes = ['Breakfast', 'Lunch', 'Dinner'] as const;

    for (const mealType of mealTypes) {
      const regex = new RegExp(`\\*\\*${mealType}\\*\\*\\s*[—–-]\\s*(.+?)(?=\\n\\*\\*(?:Breakfast|Lunch|Dinner)\\*\\*|\\n\\n|\\n##|$)`, 's');
      const match = block.match(regex);
      if (!match) continue;

      const dishLine = match[1].trim().replace(/\n/g, ' ');
      const dishParts = dishLine.split(/\s*·\s*/);

      const dishes: Dish[] = dishParts.map((part) => {
        const allergenMatch = part.match(/\(([^)]+)\)\s*$/);
        let name = part;
        let allergens: string[] = [];

        if (allergenMatch) {
          name = part.slice(0, allergenMatch.index).trim();
          const raw = allergenMatch[1];
          if (raw.toLowerCase() !== 'no allergens') {
            allergens = raw.split(/,\s*/).map((a) => a.trim().toLowerCase());
          }
        }

        const isVegan = !allergens.includes('milk') && !allergens.includes('egg');
        return { name, allergens, isVegan };
      }).filter((d) => d.name.length > 0);

      meals.push({ meal: mealType, dishes });
    }

    menus.push({ date, meals });
  }

  cachedMenus = menus;
  return cachedMenus;
}

export function getMealsForDate(date: string): MealInfo[] {
  const menus = parseFood();
  const day = menus.find((m) => m.date === date);
  return day?.meals || [];
}
