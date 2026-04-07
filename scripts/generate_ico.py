from PIL import Image
import os
import sys

def convert_to_ico(input_path, output_path):
    if not os.path.exists(input_path):
        print(f"Error: Input file {input_path} not found.")
        return False
    
    img = Image.open(input_path)
    # Icon sizes for Windows
    icon_sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    
    # Ensure directory exists
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    img.save(output_path, format='ICO', sizes=icon_sizes)
    print(f"Successfully saved icon to {output_path}")
    return True

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python generate_ico.py <input_png> <output_ico>")
        sys.exit(1)
        
    input_png = sys.argv[1]
    output_ico = sys.argv[2]
    convert_to_ico(input_png, output_ico)
