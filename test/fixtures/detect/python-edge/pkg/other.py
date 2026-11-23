import anthropic
from anthropic import Anthropic
c = Anthropic()
c.messages.stream(model="x")
c.messages.parse(model="y", dialog_id=1)
if __name__ == "__main__":
    pass
