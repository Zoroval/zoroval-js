from dotenv import load_dotenv
from prompt import parse

load_dotenv()
if __name__ == "__main__":
    parse("hi", "t")
