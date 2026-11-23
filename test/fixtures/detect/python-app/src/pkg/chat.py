class Chat:
    def __init__(self, session_id):
        self.session_id = session_id

    def stream(self, client):
        return client.chat.completions.stream(model="gpt-5", messages=[])
